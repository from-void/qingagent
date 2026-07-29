// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "@qingagent/contract-ts";
import { ServerStream } from "./serverStream";
import {
  DEFAULT_NATIVE_PRESENTATION_CONFIG,
  resetNativePresentationConfigForTest,
} from "./presentationRuntimeConfig";
import {
  presentationRunWatchdogMs,
  toContractChip,
  uploadFiles,
} from "./sessionFrameGuards";

afterEach(() => {
  MockUploadRequest.instances.length = 0;
  vi.unstubAllGlobals();
  resetNativePresentationConfigForTest(DEFAULT_NATIVE_PRESENTATION_CONFIG, null);
});

describe("toContractChip", () => {
  it("透传表格选区到乐观气泡与 wire 共用的 contract chip", () => {
    const tableSelection = {
      axis: "row" as const,
      startIndex: 0,
      endIndex: 1,
      signature: "fnv1a-deadbeef",
    };
    expect(toContractChip({
      kind: "sel",
      label: "甲 | 乙",
      suffix: "表格·第1–2行",
      blockId: "table-1",
      tableSelection,
    })).toMatchObject({
      kind: { kind: "selection" },
      resourceRef: { id: "table-1", domain: { kind: "docSpan" } },
      tableSelection,
    });
  });

  it("批注标记复用 text chip 协议并携带完整模型指令", () => {
    expect(toContractChip({
      kind: "annotation",
      label: "批注·履历时间与素材不符",
      text: "按批注修改:「2025年入职」——改为2024年（原因:履历原文为2024年）",
    })).toEqual({
      kind: { kind: "text" },
      resourceRef: null,
      prefix: null,
      label: "批注·履历时间与素材不符",
      suffix: null,
      text: "按批注修改:「2025年入职」——改为2024年（原因:履历原文为2024年）",
    });
  });

  it("文件夹子文件引用保留稳定资源身份与完整相对路径", () => {
    expect(toContractChip({
      kind: "attach",
      label: "部门甲/报告.md",
      resourceId: "folder:fld_test:%E9%83%A8%E9%97%A8%E7%94%B2%2F%E6%8A%A5%E5%91%8A.md",
    })).toEqual({
      kind: { kind: "attach" },
      resourceRef: {
        id: "folder:fld_test:%E9%83%A8%E9%97%A8%E7%94%B2%2F%E6%8A%A5%E5%91%8A.md",
        domain: { kind: "file" },
      },
      prefix: null,
      label: "部门甲/报告.md",
      suffix: null,
    });
  });
});

describe("presentationRunWatchdogMs", () => {
  it("超长全文动画无论估算多慢都在 65 秒上限内强制收口", () => {
    resetNativePresentationConfigForTest({ maxDurationMs: 60_000 }, null);
    const text = "长文终稿".repeat(20_000);
    expect(presentationRunWatchdogMs({
      id: 1,
      docVersion: 9,
      sessionId: "session-watchdog",
      mode: "whole",
      finalDoc: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{
          type: "paragraph",
          attrs: { blockId: "watchdog-final" },
          content: [{ type: "text", text }],
        }],
      },
      baselineSections: [],
      finalSections: [{
        kind: "p",
        spans: [{ kind: "text", text }],
      }],
    })).toBe(64_000);
  });
});

describe("uploadFiles", () => {
  it("逐个上传一次选择的全部文件，并将完整 fileIds 随消息发送", async () => {
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    const files = [
      new File(["alpha"], "alpha.txt", { type: "text/plain" }),
      new File(["beta"], "beta.txt", { type: "text/plain" }),
    ];

    const pendingUploads = uploadFiles(files);
    const firstRequest = await waitForUploadRequest(0);
    firstRequest.resolve({
      fileId: "file-alpha",
      filename: "alpha.txt",
      mimeType: "text/plain",
      size: 5,
    });
    const secondRequest = await waitForUploadRequest(1);
    secondRequest.resolve({
      fileId: "file-beta",
      filename: "beta.txt",
      mimeType: "text/plain",
      size: 4,
    });
    const uploadedAssets = await pendingUploads;

    expect(MockUploadRequest.instances.map((request) => request.filename())).toEqual([
      "alpha.txt",
      "beta.txt",
    ]);
    expect(MockUploadRequest.instances.map((request) => request.purpose())).toEqual([
      "material",
      "material",
    ]);
    expect(uploadedAssets.map((asset) => asset.fileId)).toEqual([
      "file-alpha",
      "file-beta",
    ]);

    let sentCommand: Command | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      sentCommand = JSON.parse(String(init?.body)) as Command;
      return new Response(
        JSON.stringify({ accepted: true, sessionId: "session-multifile", epoch: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }));
    vi.stubGlobal("EventSource", MockEventSource);
    const stream = new ServerStream();
    await stream.sendCommand({
      kind: "sendMessage",
      data: {
        sessionId: "session-multifile",
        text: "请分别读取两个文件",
        mentions: [],
        skills: [],
        chips: [],
        fileIds: uploadedAssets.map((asset) => asset.fileId),
      },
    });

    expect(sentCommand).toMatchObject({
      kind: "sendMessage",
      data: { fileIds: ["file-alpha", "file-beta"] },
    });
    stream.dispose();
  });
});

class MockEventSource extends EventTarget {
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    super();
  }

  close(): void {}
}

class MockUploadRequest {
  static instances: MockUploadRequest[] = [];

  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body = "";
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    MockUploadRequest.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: string): void {
    this.body = body;
  }

  resolve(body: unknown): void {
    this.status = 200;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }

  filename(): string | undefined {
    return (JSON.parse(this.body) as { filename?: string }).filename;
  }

  purpose(): string | undefined {
    return (JSON.parse(this.body) as { purpose?: string }).purpose;
  }
}

async function waitForUploadRequest(index: number): Promise<MockUploadRequest> {
  await vi.waitFor(() => {
    expect(MockUploadRequest.instances.length).toBeGreaterThan(index);
  });
  return MockUploadRequest.instances[index]!;
}
