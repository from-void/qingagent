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
  derivativeBriefTool,
  generateDerivativeTool,
  updateDerivativeParamsTool,
} from "../tools/derivatives.js";
import {
  styleTemplateDeleteTool,
  styleTemplateListTool,
  styleTemplateSaveTool,
} from "../tools/styleTemplates.js";

function toolContext(sessionId: string): unknown {
  return {
    requestContext: {
      get: (key: string) => (key === "sessionId" ? sessionId : undefined),
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
  it("brief 返回目标语言、排版/写作约束，参数更新校验归属", async () => {
    await documentRepo.save(
      documentInput("main", { threadId: "thread", docVersion: 1 }),
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
    )) as { ok: boolean; targetLang?: string };
    expect(translatedBrief).toMatchObject({ ok: true, targetLang: "日语" });

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
    };
    expect(brief.layoutPrompt).toContain("<mark>");
    expect(brief.writingPrompt).toContain("不得新增未经素材/主稿支撑的事实");
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
