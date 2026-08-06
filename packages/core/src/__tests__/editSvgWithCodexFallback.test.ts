import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadsBaseDir } from "@qingagent/doc-render/paths";
import { sessionWorkspaceDir } from "../workspace/sessionWorkspace.js";

const registerSessionResourceMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@qingagent/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@qingagent/db")>()),
  registerSessionResource: registerSessionResourceMock,
}));

import {
  buildSvgCodexCommand,
  editSvgWithCodexFallbackTool,
  runSvgCodexEditWithFallback,
  writeSvgCodexInstructionFile,
} from "../tools/editSvgWithCodexFallback.js";

describe("runSvgCodexEditWithFallback", () => {
  it("原生 SVG 回落导入也登记会话资源归属", async () => {
    const sessionId = `svg-fallback-resource-${Date.now()}`;
    const workspaceRoot = sessionWorkspaceDir(sessionId);
    const pairId = "11111111-1111-4111-8111-111111111111";
    const sourcePath = join(workspaceRoot, `codex-image-source-${pairId}.svg`);
    const editablePath = join(workspaceRoot, `svg-edit-output-${pairId}.svg`);
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#000"/></svg>';
    let generatedDir: string | null = null;
    registerSessionResourceMock.mockClear();
    try {
      await mkdir(workspaceRoot, { recursive: true });
      await Promise.all([
        writeFile(sourcePath, source, "utf8"),
        writeFile(editablePath, source, "utf8"),
      ]);

      const result = await editSvgWithCodexFallbackTool.execute!({
        sourcePath,
        editablePath,
        changeRequest: "把矩形改成白色",
        oldString: '#000',
        newString: '#fff',
      }, {
        requestContext: { get: (key: string) => key === "sessionId" ? sessionId : undefined },
      } as never);

      expect(result).toMatchObject({ ok: true, via: "svg-fallback" });
      const imageId = (result as { imageId?: string }).imageId;
      expect(imageId).toBeTruthy();
      generatedDir = join(uploadsBaseDir(), imageId!);
      expect(registerSessionResourceMock).toHaveBeenCalledWith({
        sessionId,
        resourceId: imageId,
        kind: "generated",
      });
    } finally {
      await Promise.all([
        rm(workspaceRoot, { recursive: true, force: true }),
        generatedDir
          ? rm(generatedDir, { recursive: true, force: true })
          : Promise.resolve(),
      ]);
    }
  });

  it("指令写入真实工作区根目录，Codex 命令只引用受控相对文件名", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "qingagent svg workspace "));
    try {
      const written = await writeSvgCodexInstructionFile(
        workspaceRoot,
        "只改太阳为月亮",
        "11111111-1111-4111-8111-111111111111",
      );

      expect(written.path).toBe(join(workspaceRoot, written.filename));
      await expect(readFile(written.path, "utf8")).resolves.toBe("只改太阳为月亮");
      const command = buildSvgCodexCommand(written.filename);
      expect(command).toContain("-C . - < codex-svg-instruction-");
      expect(command).not.toContain(workspaceRoot);
      await expect(writeSvgCodexInstructionFile(
        workspaceRoot,
        "恶意文件名",
        "../../outside",
      )).rejects.toThrow("指令文件标识无效");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("指令文件连续两次写入失败后立即调用一次原生 SVG 回落", async () => {
    const writeInstructionFile = vi.fn()
      .mockRejectedValueOnce(new Error("first write failed"))
      .mockRejectedValueOnce(new Error("second write failed"));
    const runCodexAndValidate = vi.fn();
    const importResult = vi.fn();
    const fallbackEditAndImport = vi.fn(async () => ({
      ok: true as const,
      via: "svg-fallback" as const,
      imageId: "11111111-1111-4111-8111-111111111111",
      src: "/api/v1/files/11111111-1111-4111-8111-111111111111/generated-image.svg",
      message: "本机处理未完成，已自动改用原生 SVG 定点编辑。",
    }));

    await expect(runSvgCodexEditWithFallback({
      writeInstructionFile,
      runCodexAndValidate,
      importResult,
      fallbackEditAndImport,
    })).resolves.toMatchObject({
      ok: true,
      via: "svg-fallback",
    });

    expect(writeInstructionFile).toHaveBeenCalledTimes(2);
    expect(runCodexAndValidate).not.toHaveBeenCalled();
    expect(importResult).not.toHaveBeenCalled();
    expect(fallbackEditAndImport).toHaveBeenCalledTimes(1);
    expect(fallbackEditAndImport).toHaveBeenCalledWith("instruction_write");
  });

  it("Codex 连续两次失败后不再重试并调用一次原生 SVG 回落", async () => {
    const writeInstructionFile = vi.fn(async () => "codex-svg-instruction.txt");
    const runCodexAndValidate = vi.fn()
      .mockRejectedValueOnce(new Error("first codex failed"))
      .mockRejectedValueOnce(new Error("second codex failed"));
    const importResult = vi.fn();
    const fallbackEditAndImport = vi.fn(async () => ({
      ok: true as const,
      via: "svg-fallback" as const,
      imageId: "22222222-2222-4222-8222-222222222222",
      src: "/api/v1/files/22222222-2222-4222-8222-222222222222/generated-image.svg",
      message: "本机处理未完成，已自动改用原生 SVG 定点编辑。",
    }));

    await runSvgCodexEditWithFallback({
      writeInstructionFile,
      runCodexAndValidate,
      importResult,
      fallbackEditAndImport,
    });

    expect(writeInstructionFile).toHaveBeenCalledTimes(1);
    expect(runCodexAndValidate).toHaveBeenCalledTimes(2);
    expect(importResult).not.toHaveBeenCalled();
    expect(fallbackEditAndImport).toHaveBeenCalledTimes(1);
    expect(fallbackEditAndImport).toHaveBeenCalledWith("codex_run");
  });

  it("导入连续两次失败后不再重试并调用一次原生 SVG 回落", async () => {
    const writeInstructionFile = vi.fn(async () => "codex-svg-instruction.txt");
    const runCodexAndValidate = vi.fn(async () => undefined);
    const importResult = vi.fn()
      .mockRejectedValueOnce(new Error("first import failed"))
      .mockRejectedValueOnce(new Error("second import failed"));
    const fallbackEditAndImport = vi.fn(async () => ({
      ok: true as const,
      via: "svg-fallback" as const,
      imageId: "33333333-3333-4333-8333-333333333333",
      src: "/api/v1/files/33333333-3333-4333-8333-333333333333/generated-image.svg",
      message: "本机处理未完成，已自动改用原生 SVG 定点编辑。",
    }));

    await runSvgCodexEditWithFallback({
      writeInstructionFile,
      runCodexAndValidate,
      importResult,
      fallbackEditAndImport,
    });

    expect(writeInstructionFile).toHaveBeenCalledTimes(1);
    expect(runCodexAndValidate).toHaveBeenCalledTimes(1);
    expect(importResult).toHaveBeenCalledTimes(2);
    expect(fallbackEditAndImport).toHaveBeenCalledTimes(1);
    expect(fallbackEditAndImport).toHaveBeenCalledWith("import");
  });
});
