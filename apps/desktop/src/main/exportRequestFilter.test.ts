import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isAllowedExportRequest } from "./exportRequestFilter.js";
import { ToolCallStreamScanner } from "./toolCallStreamScanner.js";

const exportDirectory = path.resolve("/tmp/qingagent-export-current");

// 导出窗口请求放行判定:对抗性输入(各种协议/host),只放行自包含资源 + Google Fonts,
// 其余一律拦截(防 SSRF、避免外部资源拖慢/卡住 printToPDF)。
test("file: 只放行当前导出临时目录，拒绝其他目录与穿越", () => {
  assert.equal(
    isAllowedExportRequest(pathToFileURL(path.join(exportDirectory, "render.html")).href, exportDirectory),
    true,
  );
  assert.equal(isAllowedExportRequest("file:///etc/passwd", exportDirectory), false);
  assert.equal(
    isAllowedExportRequest(pathToFileURL(path.join(exportDirectory, "..", "other", "secret")).href, exportDirectory),
    false,
  );
  assert.equal(
    isAllowedExportRequest(`${pathToFileURL(exportDirectory).href}-sibling/secret`, exportDirectory),
    false,
  );
});

test("data:/about: 放行(内联资源与空白页)", () => {
  assert.equal(isAllowedExportRequest("data:image/png;base64,AAAA", exportDirectory), true);
  assert.equal(isAllowedExportRequest("about:blank", exportDirectory), true);
});

test("Google Fonts 域放行(联网取中文字体)", () => {
  assert.equal(
    isAllowedExportRequest("https://fonts.googleapis.com/css2?family=Noto+Serif+SC", exportDirectory),
    true,
  );
  assert.equal(isAllowedExportRequest("https://fonts.gstatic.com/s/notoserifsc/x.woff2", exportDirectory), true);
});

test("其余外部请求一律拦截", () => {
  // 任意第三方/内网/云元数据端点都要拦,防 SSRF。
  assert.equal(isAllowedExportRequest("https://evil.example.com/steal", exportDirectory), false);
  assert.equal(isAllowedExportRequest("http://169.254.169.254/latest/meta-data/", exportDirectory), false);
  assert.equal(isAllowedExportRequest("https://fonts.googleapis.com.evil.com/x", exportDirectory), false);
  assert.equal(isAllowedExportRequest("https://sub.fonts.gstatic.com/x", exportDirectory), false);
});

test("非法/异常 URL 按拦截处理,不抛", () => {
  assert.equal(isAllowedExportRequest("not a url", exportDirectory), false);
  assert.equal(isAllowedExportRequest("", exportDirectory), false);
  assert.equal(isAllowedExportRequest("javascript:alert(1)", exportDirectory), false);
  assert.equal(isAllowedExportRequest("ftp://fonts.gstatic.com/x", exportDirectory), false);
});

test("tool call 埋点扫描:跨 chunk carry 重扫不重复上报", async () => {
  const tracked: string[] = [];
  const scanner = new ToolCallStreamScanner((name) => tracked.push(name), {
    maxSeenIds: 10,
    carryChars: 256,
  });
  const frame = toolCallFrame("call-a", "writeDraft");

  await scanner.scan(streamFromChunks([frame.slice(0, 70), frame.slice(70), frame]));

  assert.deepEqual(tracked, ["writeDraft"]);
});

test("tool call 埋点扫描:seen 上限只淘汰最旧项,不整批清空", async () => {
  const tracked: string[] = [];
  const scanner = new ToolCallStreamScanner((name) => tracked.push(name), {
    maxSeenIds: 3,
    carryChars: 0,
  });

  await scanner.scan(
    streamFromChunks([
      toolCallFrame("call-a", "toolA") +
        toolCallFrame("call-b", "toolB") +
        toolCallFrame("call-c", "toolC") +
        toolCallFrame("call-d", "toolD") +
        toolCallFrame("call-e", "toolE"),
    ]),
  );
  await scanner.scan(streamFromChunks([toolCallFrame("call-d", "toolD")]));

  assert.deepEqual(tracked, ["toolA", "toolB", "toolC", "toolD", "toolE"]);
});

function toolCallFrame(callId: string, name: string): string {
  return `data: {"kind":"toolCallUpdated","data":{"messageId":"m","toolCallId":"${callId}","spec":{"id":"s","name":"${name}","args":{}}}}\n\n`;
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
