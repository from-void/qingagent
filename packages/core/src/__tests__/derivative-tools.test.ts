import {
  createDerivativeDoc,
  documentRepo,
  getDerivativeDocument,
  getDerivativeMeta,
  getStyleTemplate,
  listStyleTemplates,
} from "@qingagent/db";
import {
  documentInput,
  pmDocFromText,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitCompiledDerivative,
  commitDerivativeQingml,
  derivativeBriefTool,
  generateDerivativeTool,
  updateDerivativeParamsTool,
} from "../tools/derivatives.js";
import {
  styleTemplateDeleteTool,
  styleTemplateListTool,
  styleTemplateSaveTool,
} from "../tools/styleTemplates.js";

function toolContext(
  sessionId: string,
  activeDerivativeDocId?: string,
): unknown {
  return {
    requestContext: {
      get: (key: string) => {
        if (key === "sessionId") return sessionId;
        if (key === "activeDerivativeDocId") return activeDerivativeDocId;
        return undefined;
      },
    },
  };
}

async function runGenerate(
  input: { derivativeDocId: string; qingml: string },
  context: unknown,
): Promise<{
  ok: boolean;
  wroteBlocks?: number;
  docVersion?: number;
  error?: string;
}> {
  return (await generateDerivativeTool.execute!(input, context as never)) as {
    ok: boolean;
    wroteBlocks?: number;
    docVersion?: number;
    error?: string;
  };
}

let db: TempDocumentsDb;

beforeEach(() => {
  db = prepareTempDocumentsDb("qa-derivative-tools-");
});

afterEach(() => db.cleanup());

describe("derivative Agent tools", () => {
  it("普通追问只允许读写当前激活的日语译稿", async () => {
    await documentRepo.save(
      documentInput("main", { threadId: "thread", docVersion: 1 }),
    );
    const japanese = await createDerivativeDoc({
      threadId: "thread",
      sourceDocId: "main",
      dtype: "translate",
      templateId: "translate-native",
      targetLang: "日语",
      privatePrompt: "",
    });
    const english = await createDerivativeDoc({
      threadId: "thread",
      sourceDocId: "main",
      dtype: "translate",
      templateId: "translate-faithful",
      targetLang: "英语",
      privatePrompt: "",
    });
    const context = toolContext("thread", japanese.docId);

    await expect(derivativeBriefTool.execute!(
      { derivativeDocId: english.docId },
      context as never,
    )).resolves.toMatchObject({ ok: false });
    await expect(updateDerivativeParamsTool.execute!(
      { derivativeDocId: english.docId, privatePrompt: "语气更正式一点" },
      context as never,
    )).resolves.toMatchObject({ ok: false });
    await expect(runGenerate(
      {
        derivativeDocId: english.docId,
        qingml: "<p>Should not be written.</p>",
      },
      context,
    )).resolves.toMatchObject({ ok: false });

    expect((await getDerivativeMeta(english.docId))?.privatePrompt).toBe("");
    expect((await getDerivativeDocument(english.docId))?.docVersion).toBe(0);
    await expect(derivativeBriefTool.execute!(
      { derivativeDocId: japanese.docId },
      context as never,
    )).resolves.toMatchObject({
      ok: true,
      targetLang: "日语",
    });
    await expect(updateDerivativeParamsTool.execute!(
      { derivativeDocId: japanese.docId, privatePrompt: "语气更正式一点" },
      context as never,
    )).resolves.toMatchObject({ ok: true });
    await expect(runGenerate(
      {
        derivativeDocId: japanese.docId,
        qingml: "<p>より正式な日本語訳。</p>",
      },
      context,
    )).resolves.toMatchObject({ ok: true, docVersion: 1 });
    expect((await getDerivativeMeta(japanese.docId))?.privatePrompt)
      .toBe("语气更正式一点");
  });

  it("brief 返回目标语言、排版/写作约束，参数更新校验归属", async () => {
    await documentRepo.save(
      documentInput("main", {
        threadId: "thread",
        docVersion: 1,
        pmDoc: {
          type: "doc",
          attrs: { schemaVersion: 1 },
          content: [{
            type: "paragraph",
            attrs: { blockId: "source-p" },
            content: [
              { type: "text", text: "源文" },
              {
                type: "footnoteReference",
                attrs: { id: "source_note", note: "来源正文" },
              },
            ],
          }],
        },
      }),
    );
    const translation = await createDerivativeDoc({
      threadId: "thread",
      sourceDocId: "main",
      dtype: "translate",
      templateId: "translate-native",
      targetLang: "日语",
      privatePrompt: "保留产品名",
    });
    const translatedBrief = (await derivativeBriefTool.execute!(
      { derivativeDocId: translation.docId },
      toolContext("thread") as never,
    )) as { ok: boolean; targetLang?: string; sourceQingml?: string };
    expect(translatedBrief).toMatchObject({ ok: true, targetLang: "日语" });
    expect(translatedBrief.sourceQingml).toContain(
      '<p>源文<footnote id="source_note">来源正文</footnote></p>',
    );

    const meta = await createDerivativeDoc({
      threadId: "thread",
      sourceDocId: "main",
      dtype: "gzh",
      templateId: "gzh-opinion",
      privatePrompt: "旧",
    });
    const brief = (await derivativeBriefTool.execute!(
      { derivativeDocId: meta.docId },
      toolContext("thread") as never,
    )) as {
      ok: boolean;
      layoutPrompt?: string;
      writingPrompt?: string;
      skillGuidance?: string;
      skillName?: string | null;
    };
    expect(brief.layoutPrompt).toContain("<mark>");
    // 纪律层已迁到子技能:事实约束由 skillGuidance 承载,writingPrompt 回归纯模板。
    expect(brief.skillName).toBe("wechat-gzh");
    expect(brief.skillGuidance).toContain("不得新增未经素材/主稿支撑的事实");
    expect(brief.writingPrompt).toContain("前三行定生死");

    const denied = (await updateDerivativeParamsTool.execute!(
      { derivativeDocId: meta.docId, privatePrompt: "越权" },
      toolContext("other") as never,
    )) as { ok: boolean };
    expect(denied.ok).toBe(false);
    const updated = (await updateDerivativeParamsTool.execute!(
      { derivativeDocId: meta.docId, privatePrompt: "整体新值" },
      toolContext("thread") as never,
    )) as { ok: boolean };
    expect(updated.ok).toBe(true);
    expect((await getDerivativeMeta(meta.docId))?.privatePrompt).toBe("整体新值");
  });

  it("generate_derivative 拒绝越权，合法 QingML 落库盖章，非法输入不推进版本", async () => {
    await documentRepo.save(
      documentInput("main", { threadId: "thread", docVersion: 3 }),
    );
    const meta = await createDerivativeDoc({
      threadId: "thread",
      sourceDocId: "main",
      dtype: "gzh",
      templateId: "gzh-opinion",
      privatePrompt: "",
    });

    const denied = await runGenerate(
      {
        derivativeDocId: meta.docId,
        qingml: "<h2>标题</h2><p>正文</p>",
      },
      toolContext("other-session"),
    );
    expect(denied.ok).toBe(false);

    const generated = await runGenerate(
      {
        derivativeDocId: meta.docId,
        qingml: "<h2>公众号标题</h2><p>正文第一段。</p>",
      },
      toolContext("thread"),
    );
    expect(generated).toMatchObject({ ok: true, docVersion: 1 });
    const written = await getDerivativeDocument(meta.docId);
    expect(JSON.stringify(written?.pmDoc)).toContain("公众号标题");
    expect((await getDerivativeMeta(meta.docId))?.sourceVersion).toBe(3);
    expect((await getDerivativeMeta(meta.docId))?.generatedAt).not.toBeNull();

    const bad = await runGenerate(
      { derivativeDocId: meta.docId, qingml: "   " },
      toolContext("thread"),
    );
    expect(bad.ok).toBe(false);
    expect((await getDerivativeDocument(meta.docId))?.docVersion).toBe(1);
  });

  it("CAS 未命中不插版本、不盖生成章", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ doc_version: 4, source_version: 9 }] })
      .mockResolvedValueOnce({ rows: [], rowsAffected: 0 });
    const result = await commitCompiledDerivative({ execute } as never, {
      derivativeDocId: "derivative-race",
      sessionId: "thread",
      doc: pmDocFromText("不会被写入"),
      expectedDocVersion: 4,
    });
    expect(result).toEqual({
      ok: false,
      error: "衍生稿版本已被并发更新,请重试",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      execute.mock.calls.some(([statement]) =>
        String(statement.sql).includes("document_versions"),
      ),
    ).toBe(false);
    expect(
      execute.mock.calls.some(([statement]) =>
        String(statement.sql).includes("generated_at"),
      ),
    ).toBe(false);
  });

  it("事务在实际 UPDATE 前再次执行最终写入 guard", async () => {
    let guarded = false;
    const execute = vi.fn(async (statement: { sql: string }) => {
      if (statement.sql.includes("SELECT derivative.doc_version")) {
        return { rows: [{ doc_version: 2, source_version: 9 }] };
      }
      expect(statement.sql).toContain("UPDATE documents SET");
      expect(guarded).toBe(true);
      return { rows: [], rowsAffected: 0 };
    });

    const result = await commitCompiledDerivative({ execute } as never, {
      derivativeDocId: "derivative-final-guard",
      sessionId: "thread",
      doc: pmDocFromText("不会被写入"),
      expectedDocVersion: 2,
      writeGuard: () => {
        guarded = true;
      },
    });

    expect(result.ok).toBe(false);
    expect(guarded).toBe(true);
  });

  it("提交入口在编译后拒绝 abort，并以启动版本阻止迟到覆盖", async () => {
    await documentRepo.save(
      documentInput("main", { threadId: "thread", docVersion: 1 }),
    );
    const meta = await createDerivativeDoc({
      threadId: "thread",
      sourceDocId: "main",
      dtype: "gzh",
      templateId: "gzh-opinion",
      privatePrompt: "",
    });
    const controller = new AbortController();
    controller.abort(new DOMException("用户已停止", "AbortError"));

    await expect(commitDerivativeQingml(
      meta.docId,
      "thread",
      "<h2>不应落库</h2><p>正文</p>",
      {
        abortSignal: controller.signal,
        expectedDocVersion: 0,
      },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect((await getDerivativeDocument(meta.docId))?.docVersion).toBe(0);

    const client = (await import("@qingagent/db")).getDocumentsClient();
    await client.execute({
      sql: "UPDATE documents SET doc_version = 1 WHERE id = ?",
      args: [meta.docId],
    });
    const stale = await commitDerivativeQingml(
      meta.docId,
      "thread",
      "<h2>迟到旧稿</h2><p>正文</p>",
      { expectedDocVersion: 0 },
    );
    expect(stale).toEqual({
      ok: false,
      error: "衍生稿版本已变化,请重试",
    });
    expect((await getDerivativeDocument(meta.docId))?.docVersion).toBe(1);
  });

  it("generate_derivative 在最终提交前执行本轮写入 guard", async () => {
    await documentRepo.save(
      documentInput("main", { threadId: "thread", docVersion: 1 }),
    );
    const meta = await createDerivativeDoc({
      threadId: "thread",
      sourceDocId: "main",
      dtype: "gzh",
      templateId: "gzh-opinion",
      privatePrompt: "",
    });
    const writeGuard = vi.fn(() => {
      throw new DOMException("旧轮次", "AbortError");
    });
    const context = {
      requestContext: {
        get: (key: string) => {
          if (key === "sessionId") return "thread";
          if (key === "qingagentTurnWriteGuardFactory") {
            return () => writeGuard;
          }
          return undefined;
        },
      },
    };

    await expect(runGenerate(
      {
        derivativeDocId: meta.docId,
        qingml: "<h2>不应落库</h2><p>正文</p>",
      },
      context,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(writeGuard).toHaveBeenCalled();
    expect((await getDerivativeDocument(meta.docId))?.docVersion).toBe(0);
  });
});

describe("style template Agent tools", () => {
  it("删除工具拒删内置模板并透传可读错误", async () => {
    const result = await styleTemplateDeleteTool.execute!(
      { id: "gzh-layout-classic" },
      {} as never,
    );
    expect(result).toEqual({
      ok: false,
      deleted: false,
      error: "内置模板不可删除",
    });
    expect(await getStyleTemplate("gzh-layout-classic")).not.toBeNull();
  });

  it("dtype 使用合法枚举，list 的 all 与省略 dtype 都返回全量", async () => {
    const all = await styleTemplateListTool.execute!({ dtype: "all" }, {} as never) as {
      ok: boolean;
      templates: Array<{ id: string }>;
    };
    const omitted = await styleTemplateListTool.execute!({}, {} as never) as {
      ok: boolean;
      templates: Array<{ id: string }>;
    };
    expect(all).toEqual(omitted);
    expect(all.templates).toHaveLength((await listStyleTemplates()).length);

    const invalid = await styleTemplateSaveTool.execute!(
      { dtype: "writing", slot: "writing", name: "孤儿", prompt: "规则" } as never,
      {} as never,
    );
    expect(invalid).toMatchObject({ error: true, message: expect.stringContaining("dtype 仅支持 gzh/xhs/translate/deai") });
  });

  it("保存工具可更新 builtin，并保留未传的 detail", async () => {
    const old = await getStyleTemplate("gzh-story");
    expect(old?.dtype).toBe("gzh");
    const result = await styleTemplateSaveTool.execute!(
      {
        id: old!.id,
        dtype: "gzh",
        slot: old!.slot,
        name: old!.name,
        prompt: "Agent 自定义提示",
      },
      {} as never,
    );
    expect(result).toEqual({
      ok: true,
      template: expect.objectContaining({
        id: old!.id,
        detail: old!.detail,
        prompt: "Agent 自定义提示",
        builtin: false,
      }),
    });
  });
});
