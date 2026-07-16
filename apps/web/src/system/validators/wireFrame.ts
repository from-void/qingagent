// Frame-ingest validator — runs at the stream boundary on every wire
// frame the client decodes. Throws on structural / domain violations.
//
// Wire 帧运行时校验的唯一真源。

import type {
  ChatChip,
  ChatMessage,
  Citation,
  DocGenerationEvent,
  DocSuggestion,
  DocSuggestionBody,
  MessagePart,
  Resource,
  ResourceDomain,
  ResourceRef,
  CodePatch,
  StreamFrame,
  ToolCallBody,
  ToolCallResult,
  ToolCallSpec,
  ToolCallStatus,
  BridgeFrame,
} from "@qingagent/contract-ts";
import { pmDocSchema } from "@qingagent/pm-schema";
import { validateAskUserSpec, AskUserSpecValidationError } from "./askUserSpec";

export class BridgeFrameValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeFrameValidationError";
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

const ALLOWED_DOC_STATE_KINDS = new Set([
  "empty",
  "editing",
  "pendingReview",
  "init",
  "plan",
  "drafting",
  "draft",
  "locked",
  "review",
  "committed",
  "history",
]);

const ALLOWED_ACTIVE_OVERLAYS = new Set([
  "askUser",
  "imageProgress",
  null,
]);
const ALLOWED_FOLDER_SOURCE_PROVIDERS = new Set(["desktop-local", "browser-fs-access"]);
const ALLOWED_FOLDER_SOURCE_STATUSES = new Set([
  "connected",
  "offline",
  "missing",
  "permission_required",
  "error",
]);
const ALLOWED_FOLDER_SOURCE_OPS = new Set(["attach", "detach"]);
const ALLOWED_FOLDER_SOURCE_FAILURE_REASONS = new Set([
  "agent_busy",
  "unsupported_environment",
  "not_found",
  "too_many_sources",
  "permission_denied",
  "invalid_path",
  "bridge_offline",
  "unknown",
]);
const FOLDER_SOURCE_PRIVATE_KEYS = new Set([
  "desktopRootPath",
  "browserHandleKey",
  "browserClientSourceId",
]);

function fail(msg: string): never {
  throw new BridgeFrameValidationError(msg);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function checkRef(field: string, ref: ResourceRef, expected?: ReadonlyArray<string>): void {
  if (!ref.id) fail(`${field}: ResourceRef.id must be non-empty`);
  if (!ALLOWED_DOMAINS.has(ref.domain.kind)) {
    fail(`${field}: invalid ResourceDomain ${ref.domain.kind}`);
  }
  if (expected && !expected.includes(ref.domain.kind)) {
    fail(
      `${field}: ResourceRef.domain must be one of [${expected.join(", ")}], got ${ref.domain.kind}`,
    );
  }
}

function checkDocStateChanged(frame: Extract<BridgeFrame, { kind: "docStateChanged" }>): void {
  const state = frame.data.state;
  if (!state || typeof state.kind !== "string") {
    fail("DocStateChanged.state.kind must be a string");
  }
  if (!ALLOWED_DOC_STATE_KINDS.has(state.kind)) {
    fail(`DocStateChanged.state.kind is invalid: ${state.kind}`);
  }
  if (!ALLOWED_ACTIVE_OVERLAYS.has(frame.data.activeOverlay)) {
    fail("DocStateChanged.activeOverlay is invalid");
  }
  if (typeof frame.data.agentBusy !== "boolean") {
    fail("DocStateChanged.agentBusy must be a boolean");
  }
}

function checkCitation(c: Citation): void {
  checkRef("Citation.sourceRef", c.sourceRef, ["source", "webpage"]);
}

function checkChip(c: ChatChip): void {
  switch (c.kind.kind) {
    case "selection": {
      if (!c.resourceRef) fail(`ChatChip kind=selection: resourceRef MUST be Some`);
      checkRef("ChatChip.resourceRef", c.resourceRef, ["docSpan"]);
      return;
    }
    case "insertion": {
      if (!c.resourceRef) fail(`ChatChip kind=insertion: resourceRef MUST be Some`);
      checkRef("ChatChip.resourceRef", c.resourceRef, ["docPosition"]);
      return;
    }
    case "attach": {
      if (!c.resourceRef) fail(`ChatChip kind=attach: resourceRef MUST be Some`);
      checkRef("ChatChip.resourceRef", c.resourceRef, ["file", "image", "url"]);
      return;
    }
    case "mention": {
      if (!c.resourceRef) fail(`ChatChip kind=mention: resourceRef MUST be Some`);
      checkRef("ChatChip.resourceRef", c.resourceRef);
      return;
    }
    case "skill":
    case "text": {
      if (c.resourceRef) {
        fail(`ChatChip kind=${c.kind.kind}: resourceRef MUST be None`);
      }
      return;
    }
  }
}

function checkCodePatch(p: CodePatch): void {
  checkRef("CodePatch.targetFile", p.targetFile, ["file"]);
  checkRef("CodePatch.baseVersion", p.baseVersion, ["version"]);
}

function checkDocSuggestion(s: DocSuggestion): void {
  if (!s.id) fail("DocSuggestion.id must be non-empty");
  if (!s.docId) fail("DocSuggestion.docId must be non-empty");
  if (!Number.isInteger(s.baseVersion) || s.baseVersion < 0) {
    fail("DocSuggestion.baseVersion must be a non-negative integer");
  }
  if (!Number.isInteger(s.baseSchemaVersion) || s.baseSchemaVersion < 0) {
    fail("DocSuggestion.baseSchemaVersion must be a non-negative integer");
  }
  if (!["reviewing", "accepted", "rejected", "committed", "conflict"].includes(s.status)) {
    fail("DocSuggestion.status is invalid");
  }
  if (s.reviewBatchId !== undefined && !s.reviewBatchId) {
    fail("DocSuggestion.reviewBatchId must be non-empty when present");
  }
  if (s.groupMode !== undefined && !["atomic", "independent"].includes(s.groupMode)) {
    fail("DocSuggestion.groupMode is invalid");
  }
  if (!s.anchor.blockId) fail("DocSuggestion.anchor.blockId must be non-empty");
  if (
    !Number.isInteger(s.anchor.pmFrom) ||
    !Number.isInteger(s.anchor.pmTo) ||
    s.anchor.pmFrom < 0 ||
    s.anchor.pmTo < s.anchor.pmFrom
  ) {
    fail("DocSuggestion.anchor pm range must be valid");
  }
  if (!s.anchor.quote) fail("DocSuggestion.anchor.quote must be non-empty");
  if (!s.anchor.textHash) fail("DocSuggestion.anchor.textHash must be non-empty");
  if (s.patch.kind !== "prosemirror_steps") {
    fail("DocSuggestion.patch.kind is invalid");
  }
  if (!Array.isArray(s.patch.steps) || s.patch.steps.length === 0) {
    fail("DocSuggestion.patch.steps must be a non-empty array");
  }
  for (const step of s.patch.steps) {
    if (!step.stepType) fail("DocSuggestion.patch.steps[].stepType must be non-empty");
    if (step.from !== undefined && (!Number.isInteger(step.from) || step.from < 0)) {
      fail("DocSuggestion.patch.steps[].from must be a non-negative integer");
    }
    if (step.to !== undefined && (!Number.isInteger(step.to) || step.to < 0)) {
      fail("DocSuggestion.patch.steps[].to must be a non-negative integer");
    }
  }
  if (typeof s.preview.deleteText !== "string" || typeof s.preview.insertText !== "string") {
    fail("DocSuggestion.preview text must be strings");
  }
  if (!s.summary) fail("DocSuggestion.summary must be non-empty");
  if (s.status === "conflict" && !s.conflict) {
    fail("DocSuggestion.conflict is required when status=conflict");
  }
}

function checkDocSuggestionBody(b: DocSuggestionBody): void {
  switch (b.kind) {
    case "suggestion":
      checkDocSuggestion(b.data);
      return;
  }
}

function checkToolBody(b: ToolCallBody): void {
  switch (b.kind) {
    case "askUser":
      try {
        validateAskUserSpec(b.data);
      } catch (e) {
        if (e instanceof AskUserSpecValidationError) {
          fail(`AskUserSpec: ${e.message}`);
        }
        throw e;
      }
      return;
    case "docSuggestion":
      checkDocSuggestionBody(b.data);
      return;
    case "spawnSubAgent":
      if (!b.data.subAgentId)
        fail(`SpawnSubAgent.subAgentId must be non-empty`);
      if (!b.data.rootTaskId)
        fail(`SpawnSubAgent.rootTaskId must be non-empty`);
      return;
    case "extractFile":
      checkRef("ExtractFile.resourceRef", b.data.resourceRef, ["file"]);
      return;
    case "extractImage":
      checkRef("ExtractImage.resourceRef", b.data.resourceRef, ["image"]);
      return;
    case "webFetch":
      checkRef("WebFetch.urlRef", b.data.urlRef, ["url"]);
      return;
    case "browserOpen":
      checkRef("BrowserOpen.urlRef", b.data.urlRef, ["url"]);
      return;
    case "qrCard":
      // content(编码模式)或 imageDataUri(图片模式,如微信后台登录码是图片非 URL)至少一个非空。
      if (
        (typeof b.data.content !== "string" || !b.data.content) &&
        (typeof b.data.imageDataUri !== "string" || !b.data.imageDataUri)
      ) {
        fail(`QrCard needs non-empty content or imageDataUri`);
      }
      for (const field of ["title", "code", "note", "confirmQuery"] as const) {
        const value = b.data[field];
        if (value !== null && typeof value !== "string") {
          fail(`QrCard.${field} must be string|null`);
        }
      }
      if (typeof b.data.expiresAt !== "number" || b.data.expiresAt <= 0)
        fail(`QrCard.expiresAt must be a positive epoch-ms timestamp`);
      if (typeof b.data.refreshQuery !== "string" || !b.data.refreshQuery) {
        fail(`QrCard.refreshQuery must be non-empty`);
      }
      if (b.data.connectorId !== undefined &&
          b.data.connectorId !== "github" &&
          b.data.connectorId !== "feishu" &&
          b.data.connectorId !== "wechat-mp") {
        fail(`QrCard.connectorId must be a known connector enum`);
      }
      if (b.data.pendingId !== undefined &&
          (typeof b.data.pendingId !== "string" || b.data.pendingId.length < 8 || b.data.pendingId.length > 128)) {
        fail(`QrCard.pendingId must be 8..128 characters`);
      }
      if (b.data.success !== undefined) {
        const success = b.data.success;
        if (!success || typeof success !== "object") fail(`QrCard.success must be an object`);
        if (success.account !== null &&
            (typeof success.account !== "string" || success.account.length > 128)) {
          fail(`QrCard.success.account must be string|null and at most 128 characters`);
        }
        if (typeof success.message !== "string" || !success.message || success.message.length > 256) {
          fail(`QrCard.success.message must be 1..256 characters`);
        }
      }
      return;
    case "readImageCard":
      if (typeof b.data.prompt !== "string") {
        fail(`ReadImageCard.prompt must be a string`);
      }
      if (b.data.thumbnailSrc !== null && typeof b.data.thumbnailSrc !== "string") {
        fail(`ReadImageCard.thumbnailSrc must be string|null`);
      }
      if (b.data.excerpt !== null && typeof b.data.excerpt !== "string") {
        fail(`ReadImageCard.excerpt must be string|null`);
      }
      return;
    case "generateSvg":
      if (typeof b.data.prompt !== "string") fail(`GenerateSvg.prompt must be a string`);
      if (b.data.style !== null && typeof b.data.style !== "string") {
        fail(`GenerateSvg.style must be string|null`);
      }
      if (b.data.aspect !== null && typeof b.data.aspect !== "string") {
        fail(`GenerateSvg.aspect must be string|null`);
      }
      if (b.data.progress !== null) {
        const p = b.data.progress;
        if (
          p.stage !== "starting" &&
          p.stage !== "streaming" &&
          p.stage !== "sanitizing" &&
          p.stage !== "done" &&
          p.stage !== "failed"
        ) {
          fail(`GenerateSvg.progress.stage is invalid`);
        }
        if (typeof p.elapsedMs !== "number" || p.elapsedMs < 0) {
          fail(`GenerateSvg.progress.elapsedMs must be a non-negative number`);
        }
        if (typeof p.rawKb !== "number" || p.rawKb < 0) {
          fail(`GenerateSvg.progress.rawKb must be a non-negative number`);
        }
        if (typeof p.message !== "string") fail(`GenerateSvg.progress.message must be a string`);
        for (const field of ["error", "src", "partialSvg"] as const) {
          if (p[field] !== null && typeof p[field] !== "string") {
            fail(`GenerateSvg.progress.${field} must be string|null`);
          }
        }
        for (const field of ["width", "height"] as const) {
          if (p[field] !== null && typeof p[field] !== "number") {
            fail(`GenerateSvg.progress.${field} must be number|null`);
          }
        }
      }
      return;
    case "browserAct":
    case "generic":
      return;
  }
}

function checkToolStatus(spec: ToolCallSpec): void {
  const status: ToolCallStatus["kind"] = spec.status.kind;
  const isPatchOnly =
    status === "reviewing" ||
    status === "accepted" ||
    status === "rejected" ||
    status === "committed";
  if (isPatchOnly && spec.body.kind !== "docSuggestion") {
    fail(
      `Patch-only ToolCallStatus "${status}" is illegal on non-docSuggestion tool-call (body=${spec.body.kind})`,
    );
  }
}

function checkToolResult(spec: ToolCallSpec): void {
  if (!spec.result) return;
  const r = spec.result;
  if (r.kind !== "producedResource") {
    if (r.kind === "askUserAnswers" || r.kind === "subAgentCompleted" || r.kind === "genericText") {
      return;
    }
    return;
  }
  // r is producedResource
  const expected: Record<string, ReadonlyArray<string>> = {
    extractFile: ["file"],
    extractImage: ["image"],
    generateSvg: ["image"],
    webFetch: ["webpage"],
  };
  const allowed = expected[spec.body.kind];
  if (allowed) {
    checkRef("ProducedResource.resourceRef", r.data.resourceRef, allowed);
  } else {
    checkRef("ProducedResource.resourceRef", r.data.resourceRef);
  }
}

function checkToolSpec(spec: ToolCallSpec): void {
  if (!spec.id) fail(`ToolCallSpec.id must be non-empty`);
  checkToolStatus(spec);
  checkToolBody(spec.body);
  checkToolResult(spec);
}

function checkMessagePart(p: MessagePart): void {
  switch (p.kind) {
    case "text":
    case "code":
    case "thinking":
    case "image":
      return;
    case "toolCall":
      checkToolSpec(p.data);
      return;
    case "citation":
      checkCitation(p.data);
      return;
    case "patchSummary":
      if (p.data.count < 0) fail(`patchSummary.count must be >= 0`);
      return;
    case "reviewOutcome":
      if (p.data.acceptedCount < 0 || p.data.rejectedCount < 0) {
        fail(`reviewOutcome counts must be >= 0`);
      }
      if (!Array.isArray(p.data.hunks)) fail(`reviewOutcome.hunks must be an array`);
      return;
    case "askUserAnswerCard":
      return;
    case "actionCard":
      if (typeof p.data.title !== "string") fail(`actionCard.title must be a string`);
      if (!Array.isArray(p.data.lines)) fail(`actionCard.lines must be an array`);
      for (const line of p.data.lines) {
        if (typeof line.label !== "string" || typeof line.value !== "string") {
          fail(`actionCard.lines[] must contain string label/value`);
        }
      }
      return;
  }
}

function checkChatMessage(m: ChatMessage): void {
  if (!m.id) fail(`ChatMessage.id must be non-empty`);
  for (const p of m.parts) checkMessagePart(p);
  if (m.chips) for (const c of m.chips) checkChip(c);
}

function checkResource(r: Resource): void {
  checkRef("Resource.resourceRef", r.resourceRef);
}

function checkStream(s: StreamFrame): void {
  switch (s.kind) {
    case "start":
    case "end":
    case "draftingFailed":
      if (!s.data.streamId) fail(`StreamFrame.streamId must be non-empty`);
      return;
  }
}

function checkDocWriteResult(frame: Extract<BridgeFrame, { kind: "docWriteResult" }>): void {
  const data = frame.data;
  if (!data.clientMutationId) {
    fail(`DocWriteResult.clientMutationId must be non-empty`);
  }
  if (data.ok) {
    if (!Number.isInteger(data.docVersion)) {
      fail(`DocWriteResult.docVersion must be an integer`);
    }
    return;
  }
  if ("conflict" in data) {
    if (!Number.isInteger(data.conflict.expectedDocumentSnapshot)) {
      fail(`DocWriteResult.conflict.expectedDocumentSnapshot must be an integer`);
    }
    if (!Number.isInteger(data.conflict.actualDocumentSnapshot)) {
      fail(`DocWriteResult.conflict.actualDocumentSnapshot must be an integer`);
    }
    return;
  }
  if (!["agent_busy", "not_editable", "not_found", "validation_error"].includes(data.reason)) {
    fail(`DocWriteResult.reason is invalid`);
  }
}

function checkFolderSource(value: unknown, index: number): void {
  if (!isRecord(value)) fail(`FolderSourcesChanged.sources[${index}] must be an object`);
  const requiredFields = [
    "id",
    "sessionId",
    "provider",
    "name",
    "pathLabel",
    "mountName",
    "mountPath",
    "readOnly",
    "fileCount",
    "fileCountCapped",
    "status",
    "error",
    "createdAt",
    "updatedAt",
  ];
  if (!requiredFields.every((field) => Object.hasOwn(value, field))) {
    fail(`FolderSourcesChanged.sources[${index}] is missing required fields`);
  }
  for (const key of FOLDER_SOURCE_PRIVATE_KEYS) {
    if (Object.hasOwn(value, key)) {
      fail(`FolderSourcesChanged.sources[${index}] must not include ${key}`);
    }
  }
  if (!nonEmptyString(value.id)) fail(`FolderSourcesChanged.sources[${index}].id must be non-empty`);
  if (!nonEmptyString(value.sessionId)) {
    fail(`FolderSourcesChanged.sources[${index}].sessionId must be non-empty`);
  }
  if (!nonEmptyString(value.provider) || !ALLOWED_FOLDER_SOURCE_PROVIDERS.has(value.provider)) {
    fail(`FolderSourcesChanged.sources[${index}].provider is invalid`);
  }
  if (!nonEmptyString(value.name)) fail(`FolderSourcesChanged.sources[${index}].name must be non-empty`);
  if (!nullableString(value.pathLabel)) {
    fail(`FolderSourcesChanged.sources[${index}].pathLabel must be string|null`);
  }
  if (!nonEmptyString(value.mountName)) {
    fail(`FolderSourcesChanged.sources[${index}].mountName must be non-empty`);
  }
  if (!nonEmptyString(value.mountPath) || value.mountPath !== `/sources/${value.mountName}`) {
    fail(`FolderSourcesChanged.sources[${index}].mountPath is invalid`);
  }
  if (value.readOnly !== true) fail(`FolderSourcesChanged.sources[${index}].readOnly must be true`);
  if (!nullableNonNegativeInteger(value.fileCount)) {
    fail(`FolderSourcesChanged.sources[${index}].fileCount must be null or a non-negative integer`);
  }
  if (typeof value.fileCountCapped !== "boolean") {
    fail(`FolderSourcesChanged.sources[${index}].fileCountCapped must be a boolean`);
  }
  if (!nonEmptyString(value.status) || !ALLOWED_FOLDER_SOURCE_STATUSES.has(value.status)) {
    fail(`FolderSourcesChanged.sources[${index}].status is invalid`);
  }
  if (!nullableString(value.error)) {
    fail(`FolderSourcesChanged.sources[${index}].error must be string|null`);
  }
  if (!nonEmptyString(value.createdAt)) {
    fail(`FolderSourcesChanged.sources[${index}].createdAt must be non-empty`);
  }
  if (!nonEmptyString(value.updatedAt)) {
    fail(`FolderSourcesChanged.sources[${index}].updatedAt must be non-empty`);
  }
}

function checkFolderSourcesChanged(frame: Extract<BridgeFrame, { kind: "folderSourcesChanged" }>): void {
  const data = frame.data as unknown;
  if (!isRecord(data)) fail("FolderSourcesChanged.data must be an object");
  if (!nonEmptyString(data.sessionId)) fail("FolderSourcesChanged.sessionId must be non-empty");
  if (!Array.isArray(data.sources)) fail("FolderSourcesChanged.sources must be an array");
  data.sources.forEach((source, index) => checkFolderSource(source, index));
}

function checkFolderSourceOperationResult(
  frame: Extract<BridgeFrame, { kind: "folderSourceOperationResult" }>,
): void {
  const data = frame.data as unknown;
  if (!isRecord(data)) fail("FolderSourceOperationResult.data must be an object");
  if (typeof data.ok !== "boolean") fail("FolderSourceOperationResult.ok must be a boolean");
  if (!nonEmptyString(data.op) || !ALLOWED_FOLDER_SOURCE_OPS.has(data.op)) {
    fail("FolderSourceOperationResult.op is invalid");
  }
  if (data.ok) {
    if (!nonEmptyString(data.folderId)) {
      fail("FolderSourceOperationResult.folderId must be non-empty on success");
    }
    return;
  }
  if (!nonEmptyString(data.reason) || !ALLOWED_FOLDER_SOURCE_FAILURE_REASONS.has(data.reason)) {
    fail("FolderSourceOperationResult.reason is invalid");
  }
}

function checkDocGenerationSeq(event: DocGenerationEvent): void {
  const data = event.data;
  if (!data.generationId) fail("DocGenerationEvent.generationId must be non-empty");
  if (!Number.isInteger(data.seq) || data.seq <= 0) {
    fail("DocGenerationEvent.seq must be a positive integer");
  }
  if (data.prevSeq !== null && (!Number.isInteger(data.prevSeq) || data.prevSeq < 0)) {
    fail("DocGenerationEvent.prevSeq must be null or a non-negative integer");
  }
}

function checkPmDoc(value: unknown, field: string): void {
  const parsed = pmDocSchema.safeParse(value);
  if (!parsed.success) {
    fail(`${field} must be a valid PM doc: ${parsed.error.message}`);
  }
}

function checkPmNode(value: unknown, field: string): void {
  if (!value || typeof value !== "object") fail(`${field} must be an object`);
  const node = value as { type?: unknown; attrs?: { blockId?: unknown } };
  if (typeof node.type !== "string" || node.type.length === 0) {
    fail(`${field}.type must be non-empty`);
  }
  if (!node.attrs || typeof node.attrs.blockId !== "string" || node.attrs.blockId.length === 0) {
    fail(`${field}.attrs.blockId must be non-empty`);
  }
}

function checkDocGenerationEvent(frame: Extract<BridgeFrame, { kind: "docGenerationEvent" }>): void {
  const event = frame.data;
  checkDocGenerationSeq(event);
  switch (event.kind) {
    case "generation_started":
      if (!event.data.sessionId) fail("generation_started.sessionId must be non-empty");
      if (!Number.isInteger(event.data.baseVersion) || event.data.baseVersion < 0) {
        fail("generation_started.baseVersion must be a non-negative integer");
      }
      return;
    case "block_started":
      if (!event.data.blockId) fail("block_started.blockId must be non-empty");
      if (!Number.isInteger(event.data.index) || event.data.index < 0) {
        fail("block_started.index must be a non-negative integer");
      }
      if (!event.data.blockType) fail("block_started.blockType must be non-empty");
      return;
    case "inline_appended":
      if (!event.data.blockId) fail("inline_appended.blockId must be non-empty");
      if (!Number.isInteger(event.data.index) || event.data.index < 0) {
        fail("inline_appended.index must be a non-negative integer");
      }
      if (!Number.isInteger(event.data.appendOffset) || event.data.appendOffset < 0) {
        fail("inline_appended.appendOffset must be a non-negative integer");
      }
      if (!event.data.run || typeof event.data.run.text !== "string") {
        fail("inline_appended.run.text must be a string");
      }
      return;
    case "block_finished":
      if (!event.data.blockId) fail("block_finished.blockId must be non-empty");
      if (!Number.isInteger(event.data.index) || event.data.index < 0) {
        fail("block_finished.index must be a non-negative integer");
      }
      if (!event.data.hash) fail("block_finished.hash must be non-empty");
      checkPmNode(event.data.pmNode, "block_finished.pmNode");
      return;
    case "generation_finished":
      if (!Number.isInteger(event.data.finalVersion) || event.data.finalVersion <= 0) {
        fail("generation_finished.finalVersion must be a positive integer");
      }
      if (!event.data.contentHash) fail("generation_finished.contentHash must be non-empty");
      checkPmDoc(event.data.doc, "generation_finished.doc");
      return;
    case "generation_failed":
      if (!event.data.reason) fail("generation_failed.reason must be non-empty");
      return;
  }
}

export function validateBridgeFrame(frame: BridgeFrame): void {
  const requestCorrelatedKinds = new Set([
    "templateDrafted", "reviewTemplatesListed", "reviewTemplateSaved", "reviewTemplateDeleted",
    "reviewTemplateSelected", "reviewSupplementLoaded", "reviewSupplementSaved", "styleTemplatesListed",
    "styleTemplateLoaded", "styleTemplateSaved", "styleTemplateDeleted", "derivativeParamsUpdated",
    "derivativesListed", "derivativeCreated", "derivativeDeleted", "derivativeDocLoaded",
  ]);
  if (requestCorrelatedKinds.has(frame.kind) && !((frame.data as { requestId?: unknown }).requestId)) {
    fail(`${frame.kind}.requestId must be non-empty`);
  }
  switch (frame.kind) {
    case "templateDrafted":
      if (!frame.data.name.trim() || !frame.data.prompt.trim()) fail("TemplateDrafted.data is invalid");
      return;
    case "reviewTemplatesListed":
      if (!Array.isArray(frame.data.items)) fail("ReviewTemplatesListed.items must be an array");
      if (frame.data.selectedTemplateId !== null && typeof frame.data.selectedTemplateId !== "string") fail("ReviewTemplatesListed.selectedTemplateId is invalid");
      return;
    case "reviewTemplateSaved":
      if (!frame.data.item.id || !frame.data.item.type) fail("ReviewTemplateSaved.item is invalid");
      return;
    case "reviewTemplateDeleted":
      if (!frame.data.id) fail("ReviewTemplateDeleted.id is invalid");
      if (frame.data.error !== undefined && !frame.data.error) fail("ReviewTemplateDeleted.error must be non-empty");
      return;
    case "reviewTemplateSelected":
      if (!frame.data.type || !frame.data.templateId) fail("ReviewTemplateSelected.data is invalid");
      return;
    case "reviewSupplementLoaded":
    case "reviewSupplementSaved":
      if (!frame.data.type || typeof frame.data.supplement !== "string") fail("ReviewSupplement.data is invalid");
      return;
    case "styleTemplateDeleted":
      if (!frame.data.id) fail("StyleTemplateDeleted.id is invalid");
      if (frame.data.error !== undefined && !frame.data.error) fail("StyleTemplateDeleted.error must be non-empty");
      return;
    case "derivativesListed":
      if (!Array.isArray(frame.data.items)) fail("DerivativesListed.items must be an array");
      return;
    case "derivativeCreated":
      if (!frame.data.item.docId) fail("DerivativeCreated.item is invalid");
      return;
    case "derivativeGenStarted":
      if (!frame.data.docId || !frame.data.targetLang) fail("DerivativeGenStarted.data is invalid");
      return;
    case "derivativeGenDelta":
      if (!frame.data.docId || !frame.data.text) fail("DerivativeGenDelta.data is invalid");
      return;
    case "derivativeGenFinished":
      if (!frame.data.docId || !frame.data.generatedAt || !Number.isInteger(frame.data.docVersion) || frame.data.docVersion < 1) fail("DerivativeGenFinished.data is invalid");
      return;
    case "derivativeGenFailed":
      if (!frame.data.docId || !frame.data.reason) fail("DerivativeGenFailed.data is invalid");
      return;
    case "derivativeDeleted":
      if (!frame.data.docId) fail("DerivativeDeleted.docId is invalid");
      return;
    case "derivativeDocLoaded":
      if (!frame.data.meta.docId || typeof frame.data.docPm !== "string") fail("DerivativeDocLoaded.data is invalid");
      return;
    case "lexiconsListed":
      for (const lexicon of frame.data.lexicons) {
        if (!lexicon.id || !lexicon.name || !Number.isInteger(lexicon.entryCount) || lexicon.entryCount < 0) {
          fail("LexiconsListed.lexicons contains an invalid resource");
        }
      }
      return;
    case "lexiconEntriesListed":
      if (!frame.data.resourceId) fail("LexiconEntriesListed.resourceId must be non-empty");
      for (const entry of frame.data.entries) {
        if (!entry.word || (entry.replacement !== null && typeof entry.replacement !== "string") || (entry.note !== null && typeof entry.note !== "string")) {
          fail("LexiconEntriesListed.entries contains an invalid entry");
        }
      }
      return;
    case "restoreReset":
      if (!Number.isInteger(frame.data.epoch) || frame.data.epoch < 0) {
        fail("RestoreReset.epoch must be a non-negative integer");
      }
      if (!Number.isInteger(frame.data.snapshotSeq) || frame.data.snapshotSeq < 0) {
        fail("RestoreReset.snapshotSeq must be a non-negative integer");
      }
      return;
    case "sessionMeta":
      return;
    case "chatMessageAdded":
      checkChatMessage(frame.data.message);
      if (
        frame.data.appendSeq !== undefined &&
        (!Number.isInteger(frame.data.appendSeq) || frame.data.appendSeq < 0)
      ) {
        fail("ChatMessageAdded.appendSeq must be a non-negative integer");
      }
      return;
    case "chatMessageAppended":
      if (!frame.data.messageId)
        fail(`ChatMessageAppended.messageId must be non-empty`);
      checkMessagePart(frame.data.part);
      return;
    case "toolCallUpdated":
      if (!frame.data.messageId)
        fail(`ToolCallUpdated.messageId must be non-empty`);
      if (!frame.data.toolCallId)
        fail(`ToolCallUpdated.toolCallId must be non-empty`);
      if (frame.data.spec.id !== frame.data.toolCallId)
        fail(`ToolCallUpdated.toolCallId must match its spec.id`);
      checkToolSpec(frame.data.spec);
      return;
    case "documentSnapshotWritten":
      checkPmDoc(frame.data.doc.doc, "documentSnapshotWritten.doc.doc");
      return;
    case "docGenerationEvent":
      checkDocGenerationEvent(frame);
      return;
    case "docCommitted":
      if (!frame.data.sessionId) fail("DocCommitted.sessionId must be non-empty");
      if (!Number.isInteger(frame.data.version)) {
        fail("DocCommitted.version must be an integer");
      }
      if (frame.data.toolCallId !== undefined && !frame.data.toolCallId) {
        fail("DocCommitted.toolCallId must be non-empty when present");
      }
      if (
        frame.data.appliedCount !== undefined &&
        (!Number.isInteger(frame.data.appliedCount) || frame.data.appliedCount < 0)
      ) {
        fail("DocCommitted.appliedCount must be a non-negative integer when present");
      }
      if (
        frame.data.conflictCount !== undefined &&
        (!Number.isInteger(frame.data.conflictCount) || frame.data.conflictCount < 0)
      ) {
        fail("DocCommitted.conflictCount must be a non-negative integer when present");
      }
      return;
    case "docDiffReady":
      if (!Number.isInteger(frame.data.baseVersion)) {
        fail(`DocDiffReady.baseVersion must be an integer`);
      }
      for (const suggestion of frame.data.suggestions) checkDocSuggestion(suggestion);
      if (frame.data.previewDoc) checkPmDoc(frame.data.previewDoc, "DocDiffReady.previewDoc");
      if (frame.data.editedDoc) checkPmDoc(frame.data.editedDoc, "DocDiffReady.editedDoc");
      return;
    case "annotationGroupsReady":
      if (!Array.isArray(frame.data.groups)) fail("AnnotationGroupsReady.groups must be an array");
      if (frame.data.replacedOrigins !== undefined) {
        if (!Array.isArray(frame.data.replacedOrigins)) fail("AnnotationGroupsReady.replacedOrigins must be an array");
        for (const origin of frame.data.replacedOrigins) {
          if (typeof origin !== "string" || !origin) fail("AnnotationGroupsReady.replacedOrigins must be non-empty strings");
        }
      }
      for (const group of frame.data.groups) {
        if (!group.id || !group.summary || !group.note || !group.origin) fail("AnnotationGroup fields must be non-empty");
        if (group.severity !== undefined && !["error", "warn", "info"].includes(group.severity)) {
          fail("AnnotationGroup.severity must be error, warn, or info");
        }
        if (!Array.isArray(group.anchors) || group.anchors.length === 0) fail("AnnotationGroup.anchors must be non-empty");
        for (const anchor of group.anchors) {
          if (!anchor.blockId || !anchor.quote || !anchor.textHash) fail("Annotation anchor fields must be non-empty");
          if (!Number.isInteger(anchor.pmFrom) || !Number.isInteger(anchor.pmTo)) fail("Annotation anchor positions must be integers");
        }
      }
      return;
    case "annotationPreview":
      if (!frame.data.previewId || !frame.data.summary || !Array.isArray(frame.data.anchors) || frame.data.anchors.length === 0) {
        fail("AnnotationPreview.data is invalid");
      }
      for (const anchor of frame.data.anchors) {
        if (!anchor.blockId || !anchor.quote || !anchor.textHash) fail("AnnotationPreview anchor fields must be non-empty");
        if (!Number.isInteger(anchor.pmFrom) || !Number.isInteger(anchor.pmTo) || anchor.pmTo <= anchor.pmFrom) fail("AnnotationPreview anchor positions are invalid");
      }
      return;
    case "annotationPreviewCleared":
      return;
    case "docStateChanged":
      checkDocStateChanged(frame);
      return;
    case "docWriteResult":
      checkDocWriteResult(frame);
      return;
    case "folderSourcesChanged":
      checkFolderSourcesChanged(frame);
      return;
    case "folderSourceOperationResult":
      checkFolderSourceOperationResult(frame);
      return;
    case "resourceUpserted":
      checkResource(frame.data.resource);
      return;
    case "resourceUpdated":
      checkRef("ResourceUpdated.resourceRef", frame.data.resourceRef);
      return;
    case "resourceRemoved":
      checkRef("ResourceRemoved.resourceRef", frame.data.resourceRef);
      return;
    case "stream":
      checkStream(frame.data);
      return;
    default:
      // 未知 kind 有意放行:保持前端对未来协议帧的前向兼容,只校验当前认识的帧。
      return;
  }
}

// Suppress unused-symbol warning on ResourceDomain (only needed for
// type narrowing in IDE).
export type { ResourceDomain };
