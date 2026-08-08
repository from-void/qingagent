/**
 * 【冻结 oracle,勿改】D6(API 边界 zod 化)前的旧手写命令校验实现,逐字搬移自
 * 提交 HEAD 的 `routes/stream.ts`(git 原样抽取,非手抄)。仅供等价回归测试当"黄金判定"
 * 用:证明新的 zod `commandSchema` 与旧手写 switch 在合法/畸形输入上判定一致。
 * 不参与生产代码,永不修改。
 */
import { safeParsePmDoc } from "@qingagent/pm-schema";
import { isValidUploadId } from "../lib/uploadStorage";

/** 旧 VALID_COMMAND_KINDS(与 Command 契约一一对应)。 */
const VALID_COMMAND_KINDS = new Set([
  "startSession",
  "sendMessage",
  "cancelStream",
  "acceptPatch",
  "rejectPatch",
  "commitPatches",
  "submitReviewOutcome",
  "resumeAskUser",
  "cancelAskUser",
  "updateDoc",
  "updateMaterialSummary",
  "removeMaterial",
  "attachFolder",
  "detachFolder",
]);

const MAX_FOLDER_COMMAND_ID_LENGTH = 256;
const MAX_FOLDER_COMMAND_NAME_LENGTH = 256;
const MAX_FOLDER_COMMAND_HANDLE_LENGTH = 1024;

function validateLegacySections(value: unknown, field: string): string | null {
  if (!Array.isArray(value)) {
    return `${field} must be an array`;
  }
  for (const [index, section] of value.entries()) {
    if (section === null || typeof section !== "object") {
      return `${field}[${index}] must be an object`;
    }
    const item = section as Record<string, unknown>;
    if (typeof item.kind !== "string") {
      return `${field}[${index}].kind must be a string`;
    }
    const data = item.data;
    if (data === null || typeof data !== "object") {
      return `${field}[${index}].data must be an object`;
    }
    const d = data as Record<string, unknown>;
    switch (item.kind) {
      case "h1":
      case "p":
      case "penNote":
        if (typeof d.text !== "string") return `${field}[${index}].data.text must be a string`;
        break;
      case "h2":
        if (typeof d.text !== "string") return `${field}[${index}].data.text must be a string`;
        if (d.anchor !== null && typeof d.anchor !== "string") {
          return `${field}[${index}].data.anchor must be null or string`;
        }
        break;
      case "code":
        if (typeof d.body !== "string") return `${field}[${index}].data.body must be a string`;
        break;
      case "table":
        if (!Array.isArray(d.head) || !Array.isArray(d.rows)) {
          return `${field}[${index}].data.head and rows must be arrays`;
        }
        break;
      case "image":
        if (typeof d.src !== "string") return `${field}[${index}].data.src must be a string`;
        if (typeof d.alt !== "string") return `${field}[${index}].data.alt must be a string`;
        if (d.caption !== null && typeof d.caption !== "string") {
          return `${field}[${index}].data.caption must be null or string`;
        }
        if (d.width !== null && typeof d.width !== "number") {
          return `${field}[${index}].data.width must be null or number`;
        }
        if (d.height !== null && typeof d.height !== "number") {
          return `${field}[${index}].data.height must be null or number`;
        }
        break;
      default:
        return `${field}[${index}].kind is not supported`;
    }
  }
  return null;
}

function validatePmDoc(value: unknown, field: string): string | null {
  const parsed = safeParsePmDoc(value);
  if (!parsed.success) return `${field} must be a valid PM doc: ${parsed.error.message}`;
  return null;
}

function validateNonEmptyBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (typeof value !== "string" || !value) {
    return `${field} must be a non-empty string`;
  }
  if (value.length > maxLength) {
    return `${field} must be at most ${maxLength} characters`;
  }
  return null;
}

/**
 * Validate the incoming command has a recognized `kind`, basic structural
 * integrity, AND the correct payload shape for each command kind.
 * Returns null if valid, or an error message.
 */
export function legacyValidateCommandKind(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return "Command must be a non-null object";
  }
  const cmd = body as Record<string, unknown>;
  if (typeof cmd.kind !== "string") {
    return "Command.kind must be a string";
  }
  if (!VALID_COMMAND_KINDS.has(cmd.kind)) {
    return `Unknown command kind: ${cmd.kind}`;
  }
  if (!("data" in cmd)) {
    return "Command.data is required";
  }

  const data = cmd.data as Record<string, unknown> | null;
  if (data === null || typeof data !== "object") {
    return "Command.data must be a non-null object";
  }

  // Per-kind payload validation
  switch (cmd.kind) {
    case "startSession": {
      // startSession.data.mode is required
      if (!data.mode || typeof data.mode !== "object") {
        return "startSession.data.mode must be an object";
      }
      const mode = data.mode as Record<string, unknown>;
      // mode.kind 必须是已知值:此前任意 kind(如 "nonsense")会被 prepareCommandForActor
      // 静默当作 new 受理并真的创建会话;mode.data 缺失则在路由层抛 TypeError 返回 500。
      if (mode.kind !== "new" && mode.kind !== "existing") {
        return 'startSession.data.mode.kind must be "new" or "existing"';
      }
      if (mode.data === null || typeof mode.data !== "object") {
        return "startSession.data.mode.data must be an object";
      }
      const modeData = mode.data as Record<string, unknown>;
      if (mode.kind === "existing") {
        const idError = validateNonEmptyBoundedString(
          modeData.id,
          "startSession.data.mode.data.id",
          MAX_FOLDER_COMMAND_ID_LENGTH,
        );
        if (idError) return idError;
      } else if (modeData.sessionId !== undefined) {
        const sessionIdError = validateNonEmptyBoundedString(
          modeData.sessionId,
          "startSession.data.mode.data.sessionId",
          MAX_FOLDER_COMMAND_ID_LENGTH,
        );
        if (sessionIdError) return sessionIdError;
      }
      break;
    }

    case "sendMessage":
      if (typeof data.sessionId !== "string" || !data.sessionId) {
        return "sendMessage.data.sessionId must be a non-empty string";
      }
      if (typeof data.text !== "string") {
        return "sendMessage.data.text must be a string";
      }
      if (!Array.isArray(data.skills)) {
        return "sendMessage.data.skills must be an array";
      }
      if (!Array.isArray(data.chips)) {
        return "sendMessage.data.chips must be an array";
      }
      // richText 可选:带 {{chip:N}} 占位的原文形态(内联 token 展开用),必须是字符串。
      if (data.richText !== undefined && typeof data.richText !== "string") {
        return "sendMessage.data.richText must be a string";
      }
      if (!Array.isArray(data.fileIds)) {
        return "sendMessage.data.fileIds must be an array";
      }
      if (Array.isArray(data.fileIds)) {
        for (const [index, fileId] of data.fileIds.entries()) {
          if (typeof fileId !== "string") {
            return `sendMessage.data.fileIds[${index}] must be a string`;
          }
          if (!isValidUploadId(fileId)) {
            return `sendMessage.data.fileIds[${index}] must be a valid UUID`;
          }
        }
      }
      break;

    case "acceptPatch":
    case "rejectPatch":
      if (
        (typeof data.id !== "string" || !data.id) &&
        (typeof data.reviewBatchId !== "string" || !data.reviewBatchId)
      ) {
        return `${cmd.kind}.data must include id or reviewBatchId`;
      }
      break;

    case "commitPatches":
      if (
        (!Array.isArray(data.ids) || data.ids.length === 0) &&
        (!Array.isArray(data.reviewBatchIds) || data.reviewBatchIds.length === 0)
      ) {
        return "commitPatches.data must include ids or reviewBatchIds";
      }
      if (data.ids !== undefined && !Array.isArray(data.ids)) {
        return "commitPatches.data.ids must be an array";
      }
      for (const id of (Array.isArray(data.ids) ? data.ids : []) as unknown[]) {
        if (typeof id !== "string" || !id) {
          return "commitPatches.data.ids[] must be non-empty strings";
        }
      }
      if (data.reviewBatchIds !== undefined) {
        if (!Array.isArray(data.reviewBatchIds)) {
          return "commitPatches.data.reviewBatchIds must be an array";
        }
        for (const id of data.reviewBatchIds as unknown[]) {
          if (typeof id !== "string" || !id) {
            return "commitPatches.data.reviewBatchIds[] must be non-empty strings";
          }
        }
      }
      break;

    case "submitReviewOutcome": {
      if (typeof data.sessionId !== "string" || !data.sessionId) {
        return "submitReviewOutcome.data.sessionId must be a non-empty string";
      }
      const outcome = data.outcome as Record<string, unknown> | null;
      if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) {
        return "submitReviewOutcome.data.outcome must be a non-null object";
      }
      if (!Number.isInteger(outcome.acceptedCount) || (outcome.acceptedCount as number) < 0) {
        return "submitReviewOutcome.data.outcome.acceptedCount must be a non-negative integer";
      }
      if (!Number.isInteger(outcome.rejectedCount) || (outcome.rejectedCount as number) < 0) {
        return "submitReviewOutcome.data.outcome.rejectedCount must be a non-negative integer";
      }
      if (!Array.isArray(outcome.hunks)) {
        return "submitReviewOutcome.data.outcome.hunks must be an array";
      }
      for (const [index, hunk] of (outcome.hunks as unknown[]).entries()) {
        if (hunk === null || typeof hunk !== "object" || Array.isArray(hunk)) {
          return `submitReviewOutcome.data.outcome.hunks[${index}] must be an object`;
        }
        const h = hunk as Record<string, unknown>;
        if (h.verdict !== "accepted" && h.verdict !== "rejected") {
          return `submitReviewOutcome.data.outcome.hunks[${index}].verdict must be "accepted" or "rejected"`;
        }
        if (typeof h.blockSummary !== "string") {
          return `submitReviewOutcome.data.outcome.hunks[${index}].blockSummary must be a string`;
        }
        if (typeof h.beforeText !== "string") {
          return `submitReviewOutcome.data.outcome.hunks[${index}].beforeText must be a string`;
        }
        if (typeof h.afterText !== "string") {
          return `submitReviewOutcome.data.outcome.hunks[${index}].afterText must be a string`;
        }
      }
      break;
    }

    case "cancelStream":
      if (typeof data.streamId !== "string" || !data.streamId) {
        return `${cmd.kind}.data.streamId must be a non-empty string`;
      }
      break;

    case "resumeAskUser":
      if (typeof data.sessionId !== "string" || !data.sessionId) {
        return "resumeAskUser.data.sessionId must be a non-empty string";
      }
      if (
        typeof data.toolCallId !== "string" ||
        !data.toolCallId
      ) {
        return "resumeAskUser.data.toolCallId must be a non-empty string";
      }
      if (
        data.answers === null ||
        typeof data.answers !== "object" ||
        Array.isArray(data.answers)
      ) {
        return "resumeAskUser.data.answers must be a non-null object";
      }
      if (Object.keys(data.answers as object).length === 0) {
        return "resumeAskUser.data.answers must contain at least one entry";
      }
      break;

    case "cancelAskUser":
      if (typeof data.sessionId !== "string" || !data.sessionId) {
        return "cancelAskUser.data.sessionId must be a non-empty string";
      }
      if (typeof data.toolCallId !== "string" || !data.toolCallId) {
        return "cancelAskUser.data.toolCallId must be a non-empty string";
      }
      break;

    case "updateDoc": {
      if (typeof data.sessionId !== "string" || !data.sessionId) {
        return "updateDoc.data.sessionId must be a non-empty string";
      }
      if (!Number.isInteger(data.expectedDocumentSnapshot)) {
        return "updateDoc.data.expectedDocumentSnapshot must be an integer";
      }
      if (typeof data.clientMutationId !== "string" || !data.clientMutationId) {
        return "updateDoc.data.clientMutationId must be a non-empty string";
      }
      if (data.doc !== undefined) {
        const pmError = validatePmDoc(data.doc, "updateDoc.data.doc");
        if (pmError) return pmError;
      } else {
        const sectionError = validateLegacySections(data.legacySections, "updateDoc.data.legacySections");
        if (sectionError) return sectionError;
      }
      break;
    }

    case "updateMaterialSummary":
      if (typeof data.sessionId !== "string" || !data.sessionId) {
        return "updateMaterialSummary.data.sessionId must be a non-empty string";
      }
      if (typeof data.materialId !== "string" || !data.materialId) {
        return "updateMaterialSummary.data.materialId must be a non-empty string";
      }
      if (typeof data.summary !== "string") {
        return "updateMaterialSummary.data.summary must be a string";
      }
      break;

    case "removeMaterial":
      if (typeof data.sessionId !== "string" || !data.sessionId) {
        return "removeMaterial.data.sessionId must be a non-empty string";
      }
      if (typeof data.materialId !== "string" || !data.materialId) {
        return "removeMaterial.data.materialId must be a non-empty string";
      }
      break;

    case "attachFolder":
      {
        const sessionIdError = validateNonEmptyBoundedString(
          data.sessionId,
          "attachFolder.data.sessionId",
          MAX_FOLDER_COMMAND_ID_LENGTH,
        );
        if (sessionIdError) return sessionIdError;
      }
      if (data.source === null || typeof data.source !== "object" || Array.isArray(data.source)) {
        return "attachFolder.data.source must be an object";
      }
      {
        const source = data.source as Record<string, unknown>;
        if (source.provider === "desktop-local") {
          const selectionTokenError = validateNonEmptyBoundedString(
            source.selectionToken,
            "attachFolder.data.source.selectionToken",
            MAX_FOLDER_COMMAND_ID_LENGTH,
          );
          if (selectionTokenError) return selectionTokenError;
        } else if (source.provider === "browser-fs-access") {
          const clientSourceIdError = validateNonEmptyBoundedString(
            source.clientSourceId,
            "attachFolder.data.source.clientSourceId",
            MAX_FOLDER_COMMAND_ID_LENGTH,
          );
          if (clientSourceIdError) return clientSourceIdError;
          const nameError = validateNonEmptyBoundedString(
            source.name,
            "attachFolder.data.source.name",
            MAX_FOLDER_COMMAND_NAME_LENGTH,
          );
          if (nameError) return nameError;
          const handleError = validateNonEmptyBoundedString(
            source.browserHandleKey,
            "attachFolder.data.source.browserHandleKey",
            MAX_FOLDER_COMMAND_HANDLE_LENGTH,
          );
          if (handleError) return handleError;
        } else {
          return "attachFolder.data.source.provider is not supported";
        }
      }
      break;

    case "detachFolder":
      {
        const sessionIdError = validateNonEmptyBoundedString(
          data.sessionId,
          "detachFolder.data.sessionId",
          MAX_FOLDER_COMMAND_ID_LENGTH,
        );
        if (sessionIdError) return sessionIdError;
        const folderIdError = validateNonEmptyBoundedString(
          data.folderId,
          "detachFolder.data.folderId",
          MAX_FOLDER_COMMAND_ID_LENGTH,
        );
        if (folderIdError) return folderIdError;
      }
      break;

  }

  return null;
}
