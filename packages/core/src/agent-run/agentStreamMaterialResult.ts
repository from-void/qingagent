import type { BridgeFrame, MessagePart, ToolCallSpec } from "@qingagent/contract-ts";
import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSubstantiveContent } from "@qingagent/doc-render/browser";
import { mastra } from "../mastra.js";
import { downloadRemoteImage } from "../tools/imageInput.js";
import type { Material } from "../types/material.js";
import {
  resolveParseFileBinding,
  upsertParseFileErrorMaterial,
  upsertParseFileReadyMaterial,
} from "./agentStreamTurnContext.js";
import type { ToolResultContext } from "./agentStreamToolResultTypes.js";
import {
  chatMessageAppended,
  resourceUpdated,
  resourceUpserted,
  toolCallUpdated,
} from "./frames.js";
import {
  findMaterialByFileId,
  materialToResource,
  parseFileFailureFromResult,
} from "../session/materialResource.js";
import { redactedSerializedText } from "./redaction.js";
import {
  appendPartToChatHistory,
  nextSeq,
  updateToolCallInChatHistory,
} from "../session/sessionState.js";
import { isExtractionFailureText } from "../session/sessionTools.js";
import { schedulePersist } from "../session/threadPersistence.js";
import { UPLOADS_BASE } from "../session/uploadFileResolver.js";
import { summarizeParseFileOutput } from "./parseFileTelemetry.js";

const logger = mastra.getLogger();

export async function* handleMaterialToolResultSideEffects(
  input: ToolResultContext,
): AsyncGenerator<BridgeFrame, void> {
  const { turn, toolName, toolCallId, args, toolResult, toolResultOk } = input;
  const { state, agentMessageId } = turn;
  const articleScrape = toolName === "fetchArticle";

  if (articleScrape) {
    const scrapeText = typeof toolResult.text === "string" ? toolResult.text : "";
    if (scrapeText !== "" && !isExtractionFailureText(scrapeText)) {
      let imageSrc: string | null = null;
      let imageLabel = "";
      try {
        const screenshot =
          typeof toolResult.screenshotSrc === "string" && toolResult.screenshotSrc;
        const openGraphImage =
          typeof toolResult.ogImageUrl === "string" && toolResult.ogImageUrl;
        if (screenshot) {
          imageSrc = toolResult.screenshotSrc as string;
          imageLabel = "网页截图";
        } else if (openGraphImage) {
          const imageId = crypto.randomUUID();
          const imageDir = join(UPLOADS_BASE, imageId);
          await mkdir(imageDir, { recursive: true });
          const image = {
            ...(await downloadRemoteImage(
              toolResult.ogImageUrl as string,
              turn.abortController.signal,
            )),
            label: "网页缩略图",
          };
          await writeFile(join(imageDir, image.filename), image.buffer);
          imageSrc = `/api/v1/files/${imageId}/${image.filename}`;
          imageLabel = image.label;
        }
      } catch (error) {
        logger.error("Failed to persist article scrape image, falling back to text card", {
          toolName,
          error: String(error),
        });
        imageSrc = null;
      }
      const imagePart: MessagePart = {
        kind: "image",
        data: {
          label: (toolResult.title as string) || imageLabel || "网页内容",
          src: imageSrc,
          srcKind: "url",
          sourceUrl: (toolResult.sourceUrl as string) || null,
          width: null,
          height: null,
        },
      };
      const seq = nextSeq(state, agentMessageId);
      yield chatMessageAppended(agentMessageId, seq, imagePart);
      appendPartToChatHistory(state, agentMessageId, imagePart);
    }
  }

  if (toolName === "parseFile") {
    const binding = resolveParseFileBinding(turn, args);
    const failure = parseFileFailureFromResult(toolResult);
    let extractionCached = false;
    if (failure) {
      upsertParseFileErrorMaterial(turn, args, failure);
    } else if (typeof toolResult.text === "string") {
      const filename = binding.filename;
      const entry = { text: toolResult.text, sourceUrl: null, fileId: binding.fileId };
      if (filename) turn.extractedTexts.set(filename, entry);
      turn.extractionEventsThisTurn.push(entry);
      extractionCached = true;
      const metadata =
        toolResult.metadata !== null &&
        typeof toolResult.metadata === "object" &&
        !Array.isArray(toolResult.metadata)
          ? toolResult.metadata as Record<string, unknown>
          : null;
      if (
        toolResultOk &&
        toolResult.text.trim().length > 0 &&
        metadata &&
        (metadata.pages === null || typeof metadata.pages === "number") &&
        typeof metadata.wordCount === "number" &&
        (metadata.title === null || typeof metadata.title === "string")
      ) {
        upsertParseFileReadyMaterial(turn, args, {
          ok: true,
          text: toolResult.text,
          metadata: {
            pages: metadata.pages,
            wordCount: metadata.wordCount,
            title: metadata.title,
            indexable: true,
          },
        });
      }
    }
    logger.info("parseFile result processed", {
      sessionId: state.sessionId,
      toolCallId,
      ...summarizeParseFileOutput(toolResult, { extractionCached }),
      hasBoundFileId: binding.fileId !== null,
      hasBoundFilename: binding.filename !== null,
      extractionsThisTurn: turn.extractionEventsThisTurn.length,
    });
  }

  if (toolName === "github_read_file" && typeof toolResult.text === "string") {
    const text = toolResult.text;
    if (text.trim() && !isExtractionFailureText(text)) {
      const sourceUrl =
        typeof toolResult.sourceUrl === "string" ? toolResult.sourceUrl : null;
      const entry = { text, sourceUrl, fileId: null, sourceKind: "github" as const };
      if (typeof toolResult.materialId === "string") {
        turn.extractedTexts.set(toolResult.materialId, entry);
      }
      if (typeof toolResult.title === "string") turn.extractedTexts.set(toolResult.title, entry);
      if (sourceUrl) turn.extractedTexts.set(sourceUrl, entry);
      turn.extractionEventsThisTurn.push(entry);
    }
  }

  if (
    toolName === "github_search_code" &&
    toolResult.selected === true &&
    typeof toolResult.text === "string"
  ) {
    const text = toolResult.text;
    if (text.trim() && !isExtractionFailureText(text)) {
      const sourceUrl =
        typeof toolResult.sourceUrl === "string" ? toolResult.sourceUrl : null;
      const entry = { text, sourceUrl, fileId: null, sourceKind: "github" as const };
      if (typeof toolResult.materialId === "string") {
        turn.extractedTexts.set(toolResult.materialId, entry);
      }
      if (typeof toolResult.title === "string") turn.extractedTexts.set(toolResult.title, entry);
      if (sourceUrl) turn.extractedTexts.set(sourceUrl, entry);
      turn.extractionEventsThisTurn.push(entry);
    }
  }

  if (articleScrape && typeof toolResult.text === "string") {
    const text = toolResult.text;
    if (!isExtractionFailureText(text) && isSubstantiveContent(text)) {
      const url = typeof args.url === "string" ? args.url : null;
      const entry = { text, sourceUrl: url, fileId: null };
      if (url) turn.extractedTexts.set(url, entry);
      const title = typeof toolResult.title === "string" ? toolResult.title.trim() : "";
      if (title) turn.extractedTexts.set(title, entry);
      const materialId =
        typeof toolResult.materialId === "string" ? toolResult.materialId : null;
      if (materialId) turn.extractedTexts.set(materialId, entry);
      turn.extractionEventsThisTurn.push(entry);
    }
  }

  if (
    toolName === "storeMaterial" &&
    toolResult.stored &&
    typeof toolResult.materialId === "string"
  ) {
    const materialId = toolResult.materialId;
    const now = new Date().toISOString();
    const resultMaterial = state.materials.get(materialId);
    const filename = typeof args.filename === "string" ? args.filename : undefined;
    const title = typeof args.title === "string" ? args.title : undefined;
    const argumentMaterialId =
      typeof args.materialId === "string" ? args.materialId : undefined;
    const stripExtension = (value: string) =>
      value.replace(/\.[A-Za-z0-9]+$/, "").trim();
    let bound =
      (argumentMaterialId ? turn.extractedTexts.get(argumentMaterialId) : undefined) ??
      (filename ? turn.extractedTexts.get(filename) : undefined) ??
      (title ? turn.extractedTexts.get(title) : undefined);
    if (!bound && filename) {
      const wanted = stripExtension(filename);
      for (const [key, entry] of turn.extractedTexts) {
        if (stripExtension(key) === wanted) {
          bound = entry;
          break;
        }
      }
    }
    if (!bound) {
      bound = turn.extractionEventsThisTurn.find(
        (entry) => !turn.consumedExtractions.has(entry),
      );
    }
    if (bound) turn.consumedExtractions.add(bound);
    const matchedFileId =
      (typeof args.fileId === "string" && args.fileId ? args.fileId : null) ??
      turn.fileIdMap.get(args.filename as string) ??
      bound?.fileId ??
      resultMaterial?.fileId ??
      null;
    const fileMaterial = matchedFileId
      ? findMaterialByFileId(state, matchedFileId)
      : null;
    const parseCreatedMaterial =
      fileMaterial !== null && turn.parseCreatedMaterialIds.has(fileMaterial.id);
    const shouldAdoptStoreMaterialId =
      parseCreatedMaterial &&
      (!resultMaterial || resultMaterial.id === fileMaterial.id);
    const targetMaterialId = fileMaterial
      ? shouldAdoptStoreMaterialId
        ? materialId
        : fileMaterial.id
      : materialId;
    const existing = fileMaterial ?? resultMaterial;
    const fullText = bound?.text ?? existing?.text ?? "";
    const hollowWebContent =
      !!bound?.sourceUrl &&
      bound.sourceKind !== "github" &&
      !isSubstantiveContent(fullText);
    const placeholderContent = isExtractionFailureText(fullText);
    if (fullText.trim().length === 0 || hollowWebContent || placeholderContent) {
      logger.warn("storeMaterial: 正文为空/空洞或解析失败,拒绝落库", {
        sessionId: state.sessionId,
        filename: args.filename,
        hollowWebContent,
        placeholderContent,
        extractionsThisTurn: turn.extractionEventsThisTurn.length,
        cachedKeys: Array.from(turn.extractedTexts.keys()).slice(0, 10),
      });
      const extractionToolNames = new Set([
        "parseFile",
        "fetchArticle",
        "webSearch",
        "github_read_file",
        "github_search_code",
      ]);
      const hadExtractionAttemptThisTurn = Array.from(
        turn.toolCallNameById.values(),
      ).some((name) => extractionToolNames.has(name));
      const reason = hollowWebContent
        ? "网页正文未能有效提取（疑似动态渲染，或仅有标题+导航/分享控件的空洞页），按解析失败处理，未写入素材库。"
        : !hadExtractionAttemptThisTurn && !existing?.text
          ? "未找到该素材的正文（可能因服务重启丢失临时解析结果），请重新解析文件或重新抓取链接。"
          : "素材正文为空或未能有效提取（空内容或不支持的格式），按解析失败处理，未写入素材库。请确认文件内容或换成支持格式后重新上传。";
      const failedSpec: ToolCallSpec = {
        id: toolCallId,
        name: toolName,
        render: { kind: "chatInline" },
        status: { kind: "failed", data: { retriable: false, reason } },
        body: { kind: "generic", data: { argsJson: redactedSerializedText(args) } },
        result: { kind: "genericText", data: reason },
      };
      updateToolCallInChatHistory(state, agentMessageId, toolCallId, failedSpec);
      yield toolCallUpdated(agentMessageId, toolCallId, failedSpec);
      return;
    }
    const material: Material = {
      id: targetMaterialId,
      filename: args.filename as string,
      mimeType: args.mimeType as string,
      text: fullText,
      summary: (args.summary as string | undefined) ?? existing?.summary ?? null,
      fileId: matchedFileId,
      metadata: {
        pages: (args.pages as number | null | undefined) ?? existing?.metadata.pages ?? null,
        wordCount: fullText.length,
        title: (args.title as string | null | undefined) ?? existing?.metadata.title ?? null,
        sourceUrl: bound?.sourceUrl ?? null,
        parseState: "ready",
        parseError: null,
      },
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    if (fileMaterial) {
      turn.materialFrames = turn.materialFrames.filter((frame) =>
        !(
          frame.kind === "resourceUpserted" &&
          frame.data.resource.resourceRef.id === fileMaterial.id
        )
      );
      turn.parseCreatedMaterialIds.delete(fileMaterial.id);
      if (fileMaterial.id !== targetMaterialId) state.materials.delete(fileMaterial.id);
    }
    state.materials.set(targetMaterialId, material);
    const metadata = {
      ...material.metadata,
      fileId: matchedFileId,
      updatedAt: material.updatedAt,
    };
    // 当场 yield 而非攒进 materialFrames 等回合收尾:输入框的「已关联素材」要在
    // 存储素材卡片落地的同时联动刷新。前端 resourceUpserted/resourceUpdated 均幂等。
    if (fileMaterial) {
      yield resourceUpserted(materialToResource(material));
    } else if (resultMaterial) {
      yield resourceUpdated(targetMaterialId, material.summary, metadata);
    } else {
      yield resourceUpserted(materialToResource(material));
    }
    schedulePersist(state, "tool_result:storeMaterial").catch((error) =>
      logger.error("Persist after storeMaterial failed", { error: String(error) }),
    );
  } else if (toolName === "summarizeMaterial") {
    const material = state.materials.get(args.materialId as string);
    if (material) {
      material.summary = args.summary as string;
      material.updatedAt = new Date().toISOString();
      yield resourceUpdated(material.id, material.summary, {
        ...material.metadata,
        fileId: material.fileId,
        updatedAt: material.updatedAt,
      });
    }
  }
}
