import type {
  BridgeFrame,
  MessagePart,
  ResearchCardBody,
  ToolCallSpec,
} from "@qingagent/contract-ts";
import crypto from "node:crypto";
import { isSubstantiveContent } from "@qingagent/doc-render/browser";
import { mastra } from "../mastra.js";
import { thumbnailSrcForImageInput } from "../tools/imageInput.js";
import { restoreDocStateAfterGenerateSvg, transitionAndProjectDocState } from "../doc-engine/docStateSync.js";
import {
  chatMessageAppended,
  ensureAgentChatHistoryMessage,
  resourceUpserted,
  toolCallUpdated,
} from "./frames.js";
import { isExtractionFailureText } from "../session/sessionTools.js";
import { resolveQrContent } from "./qrContentResolver.js";
import {
  appendPartToChatHistory,
  nextSeq,
  updateToolCallInChatHistory,
} from "../session/sessionState.js";
import { schedulePersist } from "../session/threadPersistence.js";
import {
  feishuAuthCardToolCallSpec,
  generateSvgProgressFromResult,
  generateSvgToolCallSpec,
  githubAuthCardToolCallSpec,
  latestGenerateSvgProgress,
  qrCardToolCallSpec,
  readImageToolCallSpec,
  researchCardToolCallSpec,
  wechatAuthQrToolCallSpec,
} from "./toolCards.js";
import type {
  ToolResultContext,
  ToolResultHandlerResult,
} from "./agentStreamToolResultTypes.js";

const logger = mastra.getLogger();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export async function* handleSpecialToolResult(
  input: ToolResultContext,
): AsyncGenerator<BridgeFrame, ToolResultHandlerResult> {
  const { turn, toolName, toolCallId, args, rawArgs, toolResult } = input;
  const { state, agentMessageId, outcome } = turn;

  if (toolName === "show_qr") {
    const completedCardId =
      typeof args.completedCardId === "string" && args.completedCardId.trim()
        ? args.completedCardId.trim()
        : null;
    if (completedCardId) {
      const targetMessage = state.chatHistory.find((message) =>
        message.parts.some(
          (part) =>
            part.kind === "toolCall" &&
            part.data.id === completedCardId &&
            part.data.body.kind === "qrCard",
        ),
      );
      const targetPart = targetMessage?.parts.find(
        (part) => part.kind === "toolCall" && part.data.id === completedCardId,
      );
      if (targetMessage && targetPart?.kind === "toolCall" && targetPart.data.body.kind === "qrCard") {
        const requestedMessage =
          typeof args.completionMessage === "string" ? args.completionMessage.trim() : "";
        const completionMessage = (requestedMessage || "授权已完成").slice(0, 256);
        const completedSpec: ToolCallSpec = {
          ...targetPart.data,
          status: { kind: "done" },
          body: {
            kind: "qrCard",
            data: {
              ...targetPart.data.body.data,
              success: { account: null, message: completionMessage },
            },
          },
        };
        updateToolCallInChatHistory(
          state,
          targetMessage.id,
          completedCardId,
          completedSpec,
        );
        yield toolCallUpdated(targetMessage.id, completedCardId, completedSpec);
        outcome.producedVisibleFrame = true;
      } else {
        logger.warn("show_qr 完成态目标卡不存在", {
          completedCardId,
          streamId: turn.streamId,
          sessionId: state.sessionId,
        });
      }
      return "handled";
    }

    const originalMessage = state.chatHistory.find((message) =>
      message.parts.some(
        (part) => part.kind === "toolCall" && part.data.id === toolCallId,
      ),
    );
    const originalPart = originalMessage?.parts.find(
      (part) => part.kind === "toolCall" && part.data.id === toolCallId,
    );
    if (originalMessage && originalPart?.kind === "toolCall") {
      const doneSpec: ToolCallSpec = {
        ...originalPart.data,
        status: { kind: "done" },
        result:
          originalPart.data.body.kind === "generic" && originalPart.data.result == null
            ? {
                kind: "genericText",
                data: "show_qr 缺少 content/imageDataUri,无法渲染二维码",
              }
            : originalPart.data.result,
      };
      updateToolCallInChatHistory(state, originalMessage.id, toolCallId, doneSpec);
      yield toolCallUpdated(originalMessage.id, toolCallId, doneSpec);
    } else {
      // 罕见路径:流中没渲染过这张卡,从 rawArgs 重建——同样要做出码前验真(见 qrContentResolver)
      const qrRaw = rawArgs as Record<string, unknown>;
      const resolved = qrRaw.imageDataUri ? null : await resolveQrContent(qrRaw.content);
      const spec = qrCardToolCallSpec(
        toolCallId,
        resolved ? { ...qrRaw, content: resolved } : rawArgs,
        { kind: "done" },
      );
      const seq = nextSeq(state, agentMessageId);
      const toolCallPart: MessagePart = { kind: "toolCall", data: spec };
      yield chatMessageAppended(agentMessageId, seq, toolCallPart);
      ensureAgentChatHistoryMessage(state, agentMessageId);
      appendPartToChatHistory(state, agentMessageId, toolCallPart);
      yield toolCallUpdated(agentMessageId, toolCallId, spec);
      updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
    }
    outcome.producedVisibleFrame = true;
    return "handled";
  }

  if (toolName === "wechat_auth_start") {
    const doneSpec = wechatAuthQrToolCallSpec(toolCallId, toolResult, { kind: "done" });
    const originalMessage = state.chatHistory.find((message) =>
      message.parts.some(
        (part) => part.kind === "toolCall" && part.data.id === toolCallId,
      ),
    );
    if (originalMessage) {
      updateToolCallInChatHistory(state, originalMessage.id, toolCallId, doneSpec);
      yield toolCallUpdated(originalMessage.id, toolCallId, doneSpec);
    } else {
      const seq = nextSeq(state, agentMessageId);
      const toolCallPart: MessagePart = { kind: "toolCall", data: doneSpec };
      yield chatMessageAppended(agentMessageId, seq, toolCallPart);
      ensureAgentChatHistoryMessage(state, agentMessageId);
      appendPartToChatHistory(state, agentMessageId, toolCallPart);
      yield toolCallUpdated(agentMessageId, toolCallId, doneSpec);
      updateToolCallInChatHistory(state, agentMessageId, toolCallId, doneSpec);
    }
    outcome.producedVisibleFrame = true;
    return "handled";
  }

  if (toolName === "generateSvg") {
    if (toolResult.ok === true && typeof toolResult.src === "string" && toolResult.src) {
      const imageId =
        typeof toolResult.imageId === "string" && toolResult.imageId
          ? toolResult.imageId
          : crypto.randomUUID();
      const resourceRef = { id: imageId, domain: { kind: "image" as const } };
      const previousProgress = latestGenerateSvgProgress(state, toolCallId);
      const resultProgress = generateSvgProgressFromResult(toolResult);
      const doneProgress = resultProgress
        ? {
            ...resultProgress,
            elapsedMs: previousProgress?.elapsedMs ?? resultProgress.elapsedMs,
            rawKb: previousProgress?.rawKb ?? resultProgress.rawKb,
          }
        : resultProgress;
      const doneSpec = generateSvgToolCallSpec(
        toolCallId,
        args,
        { kind: "done" },
        { kind: "producedResource", data: { resourceRef } },
        doneProgress,
      );
      yield resourceUpserted({
        resourceRef,
        displayName: typeof toolResult.alt === "string" ? toolResult.alt : "文档插图",
        summary: typeof toolResult.alt === "string" ? toolResult.alt : "",
        mime: "image/svg+xml",
        byteLen: typeof toolResult.svg === "string" ? toolResult.svg.length : null,
        createdAt: new Date().toISOString(),
        metadata: {
          src: toolResult.src,
          width: typeof toolResult.width === "number" ? toolResult.width : null,
          height: typeof toolResult.height === "number" ? toolResult.height : null,
        },
      });
      yield toolCallUpdated(agentMessageId, toolCallId, doneSpec);
      updateToolCallInChatHistory(state, agentMessageId, toolCallId, doneSpec);
      outcome.producedVisibleFrame = true;
    } else {
      const reason =
        (typeof toolResult.error === "string" && toolResult.error) || "SVG 生成失败";
      const previousProgress = latestGenerateSvgProgress(state, toolCallId);
      const failedSpec = generateSvgToolCallSpec(
        toolCallId,
        args,
        { kind: "failed", data: { retriable: false, reason } },
        null,
        {
          stage: "failed",
          elapsedMs: previousProgress?.elapsedMs ?? 0,
          rawKb: previousProgress?.rawKb ?? 0,
          message: reason,
          error: reason,
          src: previousProgress?.src ?? null,
          width: previousProgress?.width ?? null,
          height: previousProgress?.height ?? null,
          partialSvg: null,
        },
      );
      yield toolCallUpdated(agentMessageId, toolCallId, failedSpec);
      updateToolCallInChatHistory(state, agentMessageId, toolCallId, failedSpec);
      outcome.producedVisibleFrame = true;
    }
    yield* transitionAndProjectDocState(
      state,
      restoreDocStateAfterGenerateSvg(turn.generateSvgPreviousDocState, state),
      "generate_svg_finished",
      { mode: "normalize" },
    );
    turn.generateSvgPreviousDocState = null;
    return "handled";
  }

  if (toolName === "readImage") {
    const ok = toolResult.ok === true;
    const text = typeof toolResult.text === "string" ? toolResult.text : "";
    const error = typeof toolResult.error === "string" ? toolResult.error : "";
    const materialId = typeof toolResult.materialId === "string" ? toolResult.materialId : null;
    if (ok && materialId && text) {
      const material = state.materials.get(materialId);
      if (material) {
        material.visionSummary = text.slice(0, 500);
        schedulePersist(state, "tool_result:readImage").catch((persistError) =>
          logger.error("Persist after readImage material vision summary failed", {
            error: String(persistError),
          }),
        );
      }
    }
    const reason = error || "图片识别失败";
    const originalMessage = state.chatHistory.find((message) =>
      message.parts.some(
        (part) => part.kind === "toolCall" && part.data.id === toolCallId,
      ),
    );
    const originalPart = originalMessage?.parts.find(
      (part) => part.kind === "toolCall" && part.data.id === toolCallId,
    );
    const resultPreview = ok ? text : reason;
    if (originalMessage && originalPart?.kind === "toolCall") {
      const doneSpec: ToolCallSpec = {
        ...originalPart.data,
        status: ok
          ? { kind: "done" }
          : { kind: "failed", data: { retriable: true, reason } },
        result: { kind: "genericText", data: resultPreview },
      };
      updateToolCallInChatHistory(state, originalMessage.id, toolCallId, doneSpec);
      yield toolCallUpdated(originalMessage.id, toolCallId, doneSpec);
    } else {
      const thumbnailSrc =
        typeof args.image === "string" ? await thumbnailSrcForImageInput(args.image) : null;
      const spec = readImageToolCallSpec(
        toolCallId,
        args,
        ok
          ? { kind: "done" }
          : { kind: "failed", data: { retriable: true, reason } },
        { kind: "genericText", data: resultPreview },
        thumbnailSrc,
      );
      const seq = nextSeq(state, agentMessageId);
      const toolCallPart: MessagePart = { kind: "toolCall", data: spec };
      yield chatMessageAppended(agentMessageId, seq, toolCallPart);
      ensureAgentChatHistoryMessage(state, agentMessageId);
      appendPartToChatHistory(state, agentMessageId, toolCallPart);
      yield toolCallUpdated(agentMessageId, toolCallId, spec);
      updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
    }
    outcome.producedVisibleFrame = true;
    return "handled";
  }

  if (toolName === "webSearch") {
    const rawItems = Array.isArray(toolResult.items) ? toolResult.items : [];
    const cardItems: ResearchCardBody["items"] = rawItems.map((raw) => {
      const item = isRecord(raw) ? raw : {};
      const status = item.status === "skipped" ? "skipped" : "done";
      return {
        url: typeof item.url === "string" ? item.url : "",
        title: typeof item.title === "string" ? item.title : "",
        status,
        wordCount:
          status === "done" && typeof item.wordCount === "number" ? item.wordCount : null,
      };
    });
    const okCount = cardItems.filter((item) => item.status === "done").length;
    const skippedCount = cardItems.filter((item) => item.status === "skipped").length;
    const body: ResearchCardBody = {
      query:
        typeof toolResult.query === "string" ? toolResult.query : String(args.query ?? ""),
      phase: "done",
      items: cardItems,
      total: cardItems.length,
      fetchedCount: okCount + skippedCount,
      okCount,
      skippedCount,
    };
    const spec = researchCardToolCallSpec(
      toolCallId,
      body,
      { kind: "done" },
      {
        kind: "genericText",
        data: `检索完成:${cardItems.length} 个来源,${okCount} 已抓取,${skippedCount} 略过`,
      },
    );
    yield toolCallUpdated(agentMessageId, toolCallId, spec);
    updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
    outcome.producedVisibleFrame = true;
    for (const raw of rawItems) {
      if (!isRecord(raw)) continue;
      const url = typeof raw.url === "string" && raw.url ? raw.url : null;
      const title = typeof raw.title === "string" ? raw.title.trim() : "";
      const materialId = typeof raw.materialId === "string" ? raw.materialId : null;
      const cached =
        (materialId ? turn.researchFullTexts.get(materialId) : undefined) ??
        (url ? turn.researchFullTexts.get(url) : undefined) ??
        (title ? turn.researchFullTexts.get(title) : undefined);
      const text = cached?.text ?? (typeof raw.text === "string" ? raw.text : "");
      if (!text || isExtractionFailureText(text) || !isSubstantiveContent(text)) continue;
      const entry = { text, sourceUrl: url, fileId: null };
      if (url) turn.extractedTexts.set(url, entry);
      if (title) turn.extractedTexts.set(title, entry);
      if (materialId) turn.extractedTexts.set(materialId, entry);
      turn.extractionEventsThisTurn.push(entry);
    }
    return "handled";
  }

  if (toolName === "github_auth_start" && isRecord(toolResult)) {
    const spec = githubAuthCardToolCallSpec(toolCallId, {
      pendingId: typeof toolResult.pendingId === "string" ? toolResult.pendingId : "",
      userCode: typeof toolResult.user_code === "string" ? toolResult.user_code : "",
      verificationUri:
        typeof toolResult.verification_uri === "string" ? toolResult.verification_uri : "",
      expiresAt: typeof toolResult.expiresAt === "string" ? toolResult.expiresAt : "",
    });
    yield toolCallUpdated(agentMessageId, toolCallId, spec);
    updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
    outcome.producedVisibleFrame = true;
    return "handled";
  }

  if (toolName === "feishu_auth_start" && isRecord(toolResult)) {
    const mode = toolResult.mode === "configuration" ? "configuration" : "authorization";
    const url =
      mode === "configuration"
        ? typeof toolResult.configuration_url === "string"
          ? toolResult.configuration_url
          : ""
        : typeof toolResult.verification_url === "string"
          ? toolResult.verification_url
          : "";
    const spec = feishuAuthCardToolCallSpec(toolCallId, {
      mode,
      pendingId: typeof toolResult.pendingId === "string" ? toolResult.pendingId : "",
      url,
      userCode: typeof toolResult.user_code === "string" ? toolResult.user_code : undefined,
      expiresAt: typeof toolResult.expiresAt === "string" ? toolResult.expiresAt : "",
    });
    yield toolCallUpdated(agentMessageId, toolCallId, spec);
    updateToolCallInChatHistory(state, agentMessageId, toolCallId, spec);
    outcome.producedVisibleFrame = true;
    return "handled";
  }

  return "unhandled";
}
