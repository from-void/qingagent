import {
  createDerivativeDoc,
  documentRepo,
  getDerivativeDocument,
  getDerivativeMeta,
} from "@qingagent/db";
import {
  documentInput,
  prepareTempDocumentsDb,
  type TempDocumentsDb,
} from "@qingagent/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitDerivativeQingml,
  derivativeBriefTool,
  generateDerivativeTool,
} from "../tools/derivatives.js";

function toolContext(sessionId: string, abortSignal?: AbortSignal): unknown {
  return {
    requestContext: {
      get: (key: string) => key === "sessionId" ? sessionId : undefined,
    },
    abortSignal,
  };
}

async function readBrief(docId: string): Promise<{
  ok: boolean;
  targetLang?: string;
  writingPrompt?: string;
  privatePrompt?: string;
  skillGuidance?: string;
  skillName?: string | null;
  sourceQingml?: string;
}> {
  return await derivativeBriefTool.execute!(
    { derivativeDocId: docId },
    toolContext("translation-thread") as never,
  ) as never;
}

async function generate(docId: string, qingml: string, abortSignal?: AbortSignal) {
  return await generateDerivativeTool.execute!(
    { derivativeDocId: docId, qingml },
    toolContext("translation-thread", abortSignal) as never,
  ) as { ok: boolean; docVersion?: number; wroteBlocks?: number; error?: string };
}

describe("翻译统一走 Agent 衍生稿工具链", () => {
  let db: TempDocumentsDb;

  beforeEach(async () => {
    db = prepareTempDocumentsDb("qa-translation-agent-");
    await documentRepo.save(documentInput("translation-main", {
      threadId: "translation-thread",
      docVersion: 7,
      pmDoc: {
        type: "doc",
        attrs: { schemaVersion: 1 },
        content: [{
          type: "paragraph",
          attrs: { blockId: "source" },
          content: [
            { type: "text", text: "QingAgent 已发布，数字 42 必须保留。" },
            {
              type: "footnoteReference",
              attrs: { id: "source_note", note: "来源正文" },
            },
          ],
        }],
      },
    }));
  });

  afterEach(() => db.cleanup());

  async function createTargets() {
    const english = await createDerivativeDoc({
      threadId: "translation-thread",
      sourceDocId: "translation-main",
      dtype: "translate",
      templateId: "translate-faithful",
      targetLang: "英语",
      privatePrompt: "保留产品名",
    });
    const japanese = await createDerivativeDoc({
      threadId: "translation-thread",
      sourceDocId: "translation-main",
      dtype: "translate",
      templateId: "translate-native",
      targetLang: "日语",
      privatePrompt: "数字不变",
    });
    return { english, japanese };
  }

  it("多语种按目标顺序读取 translate 纪律与模板并逐篇提交，全部推进版本", async () => {
    const { english, japanese } = await createTargets();
    const order: string[] = [];

    const englishBrief = await readBrief(english.docId);
    order.push(`brief:${englishBrief.targetLang}`);
    expect(englishBrief).toMatchObject({
      ok: true,
      targetLang: "英语",
      privatePrompt: "保留产品名",
      skillName: "translate",
    });
    expect(englishBrief.writingPrompt).toContain("忠实");
    expect(englishBrief.skillGuidance).toContain("严格按指定目标语言翻译主文档");
    expect(englishBrief.sourceQingml).toContain(
      '<footnote id="source_note">来源正文</footnote>',
    );
    const englishResult = await generate(
      english.docId,
      '<p>QingAgent has launched, and the number 42 must remain.<footnote id="source_note">Source text</footnote></p>',
    );
    order.push("generate:英语");

    const japaneseBrief = await readBrief(japanese.docId);
    order.push(`brief:${japaneseBrief.targetLang}`);
    expect(japaneseBrief).toMatchObject({
      ok: true,
      targetLang: "日语",
      privatePrompt: "数字不变",
      skillName: "translate",
    });
    expect(japaneseBrief.writingPrompt).toContain("母语");
    const japaneseResult = await generate(
      japanese.docId,
      '<p>QingAgent は公開済みで、数字の 42 は保持します。<footnote id="source_note">出典本文</footnote></p>',
    );
    order.push("generate:日语");

    expect(order).toEqual([
      "brief:英语",
      "generate:英语",
      "brief:日语",
      "generate:日语",
    ]);
    expect(englishResult).toMatchObject({ ok: true, docVersion: 1 });
    expect(japaneseResult).toMatchObject({ ok: true, docVersion: 1 });
    expect((await getDerivativeDocument(english.docId))?.docVersion).toBe(1);
    expect((await getDerivativeDocument(japanese.docId))?.docVersion).toBe(1);
    expect((await getDerivativeMeta(english.docId))?.sourceVersion).toBe(7);
    expect((await getDerivativeMeta(japanese.docId))?.sourceVersion).toBe(7);
    expect((await getDerivativeMeta(english.docId))?.generatedAt).not.toBeNull();
    expect((await getDerivativeMeta(japanese.docId))?.generatedAt).not.toBeNull();
  });

  it("停止 Agent 轮次后 generate_derivative 不落库且不留下生成章", async () => {
    const { english } = await createTargets();
    const controller = new AbortController();
    controller.abort(new DOMException("用户停止", "AbortError"));

    await expect(generate(
      english.docId,
      "<p>Must not be committed.</p>",
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect((await getDerivativeDocument(english.docId))?.docVersion).toBe(0);
    expect((await getDerivativeMeta(english.docId))?.generatedAt).toBeNull();
  });

  it("翻译提交继续复用既有 CAS，旧启动版本不能覆盖新版本", async () => {
    const { english } = await createTargets();
    expect(await generate(english.docId, "<p>First translation.</p>"))
      .toMatchObject({ ok: true, docVersion: 1 });

    const stale = await commitDerivativeQingml(
      english.docId,
      "translation-thread",
      "<p>Late stale translation.</p>",
      { expectedDocVersion: 0 },
    );
    expect(stale).toEqual({ ok: false, error: "衍生稿版本已变化,请重试" });
    expect((await getDerivativeDocument(english.docId))?.docVersion).toBe(1);
  });
});
