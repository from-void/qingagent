// Command validator — runs at command dispatch (UI before send).
// 无状态，是 command 运行时校验的唯一真源。
//
import type { ChatChip, Command, ResourceRef, SendMessage } from "@qingagent/contract-ts";
import { safeParsePmDoc } from "@qingagent/pm-schema";

export class CommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandValidationError";
  }
}

const ALLOWED_DOMAINS = new Set([
  "file",
  "image",
  "url",
  "source",
  "docSpan",
  "docPosition",
  "version",
  "mention",
  "citation",
  "webpage",
]);

function fail(msg: string): never {
  throw new CommandValidationError(msg);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function checkRefAny(field: string, ref: ResourceRef): void {
  if (!ref.id) fail(`${field}: ResourceRef.id must be non-empty`);
  if (!ALLOWED_DOMAINS.has(ref.domain.kind))
    fail(`${field}: invalid ResourceDomain ${ref.domain.kind}`);
}

function checkChip(c: ChatChip): void {
  if (c.tableSelection !== undefined) {
    if (c.kind.kind !== "selection") {
      fail(`ChatChip.tableSelection is only allowed for selection chips`);
    }
    const { axis, startIndex, endIndex } = c.tableSelection;
    if (axis !== "row" && axis !== "column") {
      fail(`ChatChip.tableSelection.axis must be row|column`);
    }
    if (!Number.isInteger(startIndex) || startIndex < 0) {
      fail(`ChatChip.tableSelection.startIndex must be a non-negative integer`);
    }
    if (!Number.isInteger(endIndex) || endIndex < 0) {
      fail(`ChatChip.tableSelection.endIndex must be a non-negative integer`);
    }
    if (startIndex > endIndex) {
      fail(`ChatChip.tableSelection startIndex must be <= endIndex`);
    }
  }
  switch (c.kind.kind) {
    case "selection":
      if (!c.resourceRef) fail(`ChatChip kind=selection: resourceRef MUST be Some`);
      checkRefAny("ChatChip.resourceRef", c.resourceRef);
      if (c.resourceRef.domain.kind !== "docSpan")
        fail(`ChatChip kind=selection: resourceRef.domain must be docSpan`);
      return;
    case "insertion":
      if (!c.resourceRef) fail(`ChatChip kind=insertion: resourceRef MUST be Some`);
      checkRefAny("ChatChip.resourceRef", c.resourceRef);
      if (c.resourceRef.domain.kind !== "docPosition")
        fail(`ChatChip kind=insertion: resourceRef.domain must be docPosition`);
      return;
    case "attach":
      if (!c.resourceRef) fail(`ChatChip kind=attach: resourceRef MUST be Some`);
      checkRefAny("ChatChip.resourceRef", c.resourceRef);
      if (
        c.resourceRef.domain.kind !== "file" &&
        c.resourceRef.domain.kind !== "image" &&
        c.resourceRef.domain.kind !== "url"
      )
        fail(`ChatChip kind=attach: resourceRef.domain must be file|image|url`);
      return;
    case "mention":
      if (!c.resourceRef) fail(`ChatChip kind=mention: resourceRef MUST be Some`);
      checkRefAny("ChatChip.resourceRef", c.resourceRef);
      return;
    case "skill":
    case "text":
      if (c.resourceRef) fail(`ChatChip kind=${c.kind.kind}: resourceRef MUST be None`);
      return;
  }
}

function checkSendMessage(m: SendMessage): void {
  if (!m.sessionId) fail(`SendMessage.sessionId must be non-empty`);
  for (const r of m.mentions) checkRefAny("SendMessage.mentions[]", r);
  for (const c of m.chips) checkChip(c);
  // fileIds is optional; when present each entry must be a non-empty string
  if (m.fileIds) {
    for (const id of m.fileIds) {
      if (!id) fail(`SendMessage.fileIds[] must be non-empty`);
    }
  }
}

function checkLegacySections(value: unknown): void {
  if (!Array.isArray(value)) fail(`UpdateDoc.legacySections must be an array`);
  for (const [index, section] of value.entries()) {
    if (section === null || typeof section !== "object") {
      fail(`UpdateDoc.legacySections[${index}] must be an object`);
    }
    const item = section as Record<string, unknown>;
    const data = item.data as Record<string, unknown> | null | undefined;
    if (typeof item.kind !== "string") {
      fail(`UpdateDoc.legacySections[${index}].kind must be a string`);
    }
    if (!data || typeof data !== "object") {
      fail(`UpdateDoc.legacySections[${index}].data must be an object`);
    }
  }
}

function checkPmDoc(value: unknown): void {
  const parsed = safeParsePmDoc(value);
  if (!parsed.success) fail(`UpdateDoc.doc must be a valid PM doc: ${parsed.error.message}`);
}

export function validateCommand(cmd: Command): void {
  switch (cmd.kind) {
    case "startSession":
      return;
    case "sendMessage":
      checkSendMessage(cmd.data);
      return;
    case "cancelStream":
      if (!cmd.data.streamId) fail(`${cmd.kind}.streamId must be non-empty`);
      return;
    case "acceptPatch":
    case "rejectPatch":
      if (!cmd.data.id && !cmd.data.reviewBatchId) {
        fail(`${cmd.kind} must include id or reviewBatchId`);
      }
      return;
    case "commitPatches":
      if (cmd.data.ids.length === 0) fail(`CommitPatches.ids must be non-empty`);
      for (const id of cmd.data.ids) {
        if (!id) fail(`CommitPatches.ids[] must be non-empty`);
      }
      for (const id of cmd.data.reviewBatchIds ?? []) {
        if (!id) fail(`CommitPatches.reviewBatchIds[] must be non-empty`);
      }
      return;
    case "submitReviewOutcome": {
      if (!cmd.data.sessionId) fail(`SubmitReviewOutcome.sessionId must be non-empty`);
      const outcome = cmd.data.outcome;
      if (!outcome || typeof outcome !== "object") {
        fail(`SubmitReviewOutcome.outcome must be an object`);
      }
      if (!Array.isArray(outcome.hunks)) {
        fail(`SubmitReviewOutcome.outcome.hunks must be an array`);
      }
      for (const [index, hunk] of outcome.hunks.entries()) {
        if (hunk.verdict !== "accepted" && hunk.verdict !== "rejected") {
          fail(`SubmitReviewOutcome.outcome.hunks[${index}].verdict must be accepted|rejected`);
        }
      }
      return;
    }
    case "resumeAskUser":
      if (!cmd.data.sessionId) fail(`ResumeAskUser.sessionId must be non-empty`);
      if (cmd.data.toolCallId !== undefined && !cmd.data.toolCallId) {
        fail(`ResumeAskUser.toolCallId must be non-empty`);
      }
      if (Object.keys(cmd.data.answers).length === 0)
        fail(`ResumeAskUser.answers must contain at least one entry`);
      return;
    case "cancelAskUser":
      if (!cmd.data.sessionId) fail(`CancelAskUser.sessionId must be non-empty`);
      if (!cmd.data.toolCallId) fail(`CancelAskUser.toolCallId must be non-empty`);
      return;
    case "updateDoc":
      if (!cmd.data.sessionId) fail(`UpdateDoc.sessionId must be non-empty`);
      if (!Number.isInteger(cmd.data.expectedDocumentSnapshot))
        fail(`UpdateDoc.expectedDocumentSnapshot must be an integer`);
      if (!cmd.data.clientMutationId)
        fail(`UpdateDoc.clientMutationId must be non-empty`);
      if (cmd.data.doc) checkPmDoc(cmd.data.doc);
      else checkLegacySections(cmd.data.legacySections);
      return;
    case "updateMaterialSummary":
      if (!cmd.data.sessionId) fail(`UpdateMaterialSummary.sessionId must be non-empty`);
      if (!cmd.data.materialId) fail(`UpdateMaterialSummary.materialId must be non-empty`);
      // summary 允许空串(用户可清空摘要),只校验类型
      if (typeof cmd.data.summary !== "string")
        fail(`UpdateMaterialSummary.summary must be a string`);
      return;
    case "removeMaterial":
      if (!cmd.data.sessionId) fail(`RemoveMaterial.sessionId must be non-empty`);
      if (!cmd.data.materialId) fail(`RemoveMaterial.materialId must be non-empty`);
      return;
    case "reparseMaterial": {
      const data = cmd.data as unknown;
      if (!isRecord(data)) fail(`ReparseMaterial.data must be an object`);
      if (!nonEmptyString(data.sessionId)) fail(`ReparseMaterial.sessionId must be non-empty`);
      if (!nonEmptyString(data.fileId)) fail(`ReparseMaterial.fileId must be non-empty`);
      return;
    }
    case "attachFolder": {
      const data = cmd.data as unknown;
      if (!isRecord(data)) fail(`AttachFolder.data must be an object`);
      if (!nonEmptyString(data.sessionId)) fail(`AttachFolder.sessionId must be non-empty`);
      const source = data.source;
      if (!isRecord(source)) fail(`AttachFolder.source must be an object`);
      if (source.provider === "desktop-local") {
        if (!nonEmptyString(source.selectionToken)) {
          fail(`AttachFolder.source.selectionToken must be non-empty`);
        }
        return;
      }
      if (source.provider === "browser-fs-access") {
        if (!nonEmptyString(source.clientSourceId)) {
          fail(`AttachFolder.source.clientSourceId must be non-empty`);
        }
        if (!nonEmptyString(source.name)) fail(`AttachFolder.source.name must be non-empty`);
        if (!nonEmptyString(source.browserHandleKey)) {
          fail(`AttachFolder.source.browserHandleKey must be non-empty`);
        }
        return;
      }
      fail(`AttachFolder.source.provider is not supported`);
    }
    case "detachFolder": {
      const data = cmd.data as unknown;
      if (!isRecord(data)) fail(`DetachFolder.data must be an object`);
      if (!nonEmptyString(data.sessionId)) fail(`DetachFolder.sessionId must be non-empty`);
      if (!nonEmptyString(data.folderId)) fail(`DetachFolder.folderId must be non-empty`);
      return;
    }
  }
}
