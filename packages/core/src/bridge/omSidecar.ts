import type { CoreMessage } from "ai";
import type { MastraDBMessage } from "@mastra/core/agent";
import { SpanType } from "@mastra/core/observability";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import type { ObservationalMemoryRecord } from "@mastra/core/storage";
import { ObservationalMemory, TokenCounter } from "@mastra/memory/processors";
import { createAnthropic as createAnthropicV5 } from "@ai-sdk/anthropic-v5";
import type { ChatMessage } from "@qingagent/contract-ts";
import {
  createRepairingQingagentModel,
  qingagentModelConfig,
  wrapToolCallRepairingModel,
} from "../llm/repairingModel.js";
import type {
  RepairableLanguageModel,
  RepairingModelRouterLanguageModel,
} from "../llm/repairingModel.js";
import {
  anthropicBaseUrl,
  MODEL_OVERRIDES_CONTEXT_KEY,
  resolveBaseUrl,
  resolveDeepseekAuth,
  resolveDeepseekRouterModelId,
  resolveModelId,
  resolveProtocol,
} from "../llm/modelConfig.js";
import {
  buildOmObservationsContent,
  buildOmObservationsPromptMessage,
} from "../llm/omObservationsPrompt.js";
import { wrapModernModelUsage } from "../llm/modernUsageModel.js";
import { isWorkingMemoryPromptMessage } from "../llm/workingMemoryPrompt.js";
import { getMemory, getObservability, mastra } from "../mastra.js";
import type { OmSidecarCursor, SessionState } from "./sessionState.js";
import { sessionIdToTraceId } from "./agentSpans.js";
import {
  QINGAGENT_RESOURCE_ID,
  schedulePersist,
} from "./threadPersistence.js";

const logger = mastra.getLogger();

export const OM_SIDECAR_ENV = "QINGAGENT_OM_SIDECAR";
export const OM_COMPRESS_ENV = "QINGAGENT_OM_COMPRESS";
export const OM_COMPRESS_THRESHOLD_ENV = "QINGAGENT_OM_COMPRESS_THRESHOLD_TOKENS";
export const OM_COMPRESS_RECENT_TURNS_ENV = "QINGAGENT_OM_COMPRESS_RECENT_TURNS";
export const OM_DEFAULT_COMPRESS_THRESHOLD_TOKENS = 160_000;
export const OM_DEFAULT_RECENT_TURNS = 12;

type AgentAnthropicModel = ReturnType<ReturnType<typeof createAnthropicV5>>;
type RepairingAgentAnthropicModel = AgentAnthropicModel & RepairableLanguageModel;

const observerModelCache = new Map<
  string,
  RepairingModelRouterLanguageModel | RepairingAgentAnthropicModel
>();
const OBSERVER_MODEL_CACHE_LIMIT = 16;
const OM_STORAGE_THREAD_PREFIX = "om-sidecar";
const OM_STORAGE_RESOURCE_SUFFIX = "om-sidecar";
let omSidecarPromise: Promise<ObservationalMemory | null> | null = null;
const omSidecarQueues = new Map<string, Promise<void>>();
const tokenCounter = new TokenCounter();

type OmCursorCommitter = (cursor: OmSidecarCursor) => Promise<void>;
type OmObservedIdsCommitter = (ids: readonly string[]) => Promise<void>;

export interface OmMessageAssignment {
  message: CoreMessage;
  messageIndex: number;
  id: string;
  turnIndex: number;
  seqInTurn: number;
  createdAt: Date;
}

export interface OmPreparedContext {
  messagesForModel: CoreMessage[];
  tailObservationPrompt: string | null;
  compressed: boolean;
  fullTokenEstimate: number;
  projectedTokenEstimate: number;
  removedMessageIds: string[];
  observations: string | null;
}

export interface PrepareOmContextOptions {
  allowCompressionActivation?: boolean;
}

export interface OmProjectionInput {
  sessionId: string;
  messages: CoreMessage[];
  chatHistory?: ChatMessage[];
  observations: string | null | undefined;
  observedMessageIds: Iterable<string>;
  compressionAlreadyActive?: boolean;
  latestTurnIndex?: number;
  thresholdTokens?: number;
  recentTurns?: number;
}

export interface OmProjectionResult {
  messages: CoreMessage[];
  compressed: boolean;
  fullTokenEstimate: number;
  projectedTokenEstimate: number;
  removedMessageIds: string[];
}

export interface OmTurnSnapshotOptions {
  turnIndex?: number | null;
  turnStartMessageIndex?: number | null;
}

interface OmSidecarTurnSnapshot {
  sessionId: string;
  threadId: string;
  resourceId: string;
  messages: CoreMessage[];
  chatHistory: ChatMessage[];
  cursor: OmSidecarCursor | null;
  currentTurn: {
    turnIndex: number;
    startMessageIndex: number;
  } | null;
}

export function isOmSidecarEnabled(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): boolean {
  return isTruthyFlag(env[OM_SIDECAR_ENV]);
}

export function isOmCompressionEnabled(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): boolean {
  return isTruthyFlag(env[OM_COMPRESS_ENV]);
}

export function omCompressionThresholdTokens(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): number {
  const raw = Number(env[OM_COMPRESS_THRESHOLD_ENV]);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : OM_DEFAULT_COMPRESS_THRESHOLD_TOKENS;
}

export function omCompressionRecentTurns(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): number {
  const raw = Number(env[OM_COMPRESS_RECENT_TURNS_ENV]);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : OM_DEFAULT_RECENT_TURNS;
}

export function makeOmMessageId(
  sessionId: string,
  turnIndex: number,
  seqInTurn: number,
): string {
  return `${sessionId}-${turnIndex}-${seqInTurn}`;
}

export function omSidecarThreadId(threadId: string): string {
  return threadId.startsWith(`${OM_STORAGE_THREAD_PREFIX}:`)
    ? threadId
    : `${OM_STORAGE_THREAD_PREFIX}:${threadId}`;
}

export function omSidecarResourceId(resourceId: string): string {
  return resourceId.endsWith(`:${OM_STORAGE_RESOURCE_SUFFIX}`)
    ? resourceId
    : `${resourceId}:${OM_STORAGE_RESOURCE_SUFFIX}`;
}

export function compareOmCursor(
  left: OmSidecarCursor,
  right: OmSidecarCursor,
): number {
  if (left.turnIndex !== right.turnIndex) return left.turnIndex - right.turnIndex;
  return left.seqInTurn - right.seqInTurn;
}

export function estimateTurnCounterFromMessages(messages: readonly CoreMessage[]): number {
  let turns = 0;
  for (const message of messages) {
    if (isInternalOmContextMessage(message)) continue;
    if (startsNewFallbackTurn(message)) turns += 1;
  }
  return turns;
}

export function nextOmTurnIndex(
  state: Pick<SessionState, "turnCounter" | "messages" | "omSidecarCursor">,
): number {
  return Math.max(
    Number.isFinite(state.turnCounter) && state.turnCounter > 0
      ? Math.floor(state.turnCounter)
      : 0,
    estimateTurnCounterFromMessages(state.messages),
    state.omSidecarCursor?.turnIndex ?? 0,
  ) + 1;
}

export function isInternalOmContextMessage(message: CoreMessage): boolean {
  return isWorkingMemoryPromptMessage(message);
}

export function buildOmMessageAssignments(input: {
  sessionId: string;
  messages: readonly CoreMessage[];
  chatHistory?: readonly ChatMessage[];
  latestTurnIndex?: number | null;
  currentTurn?: {
    turnIndex: number;
    startMessageIndex: number;
  } | null;
}): OmMessageAssignment[] {
  const chatTimeline = buildChatTimeline(input.chatHistory ?? []);
  const rawAssignments: Array<Omit<OmMessageAssignment, "id" | "createdAt"> & {
    anchoredToCurrentTurn: boolean;
    fallbackSegmentIndex: number | null;
  }> = [];
  const currentTurn = normalizeCurrentTurn(input.currentTurn);
  let fallbackSegmentIndex = 0;
  let currentTurnSeqInTurn = 0;

  for (let messageIndex = 0; messageIndex < input.messages.length; messageIndex += 1) {
    const message = input.messages[messageIndex]!;
    if (isInternalOmContextMessage(message)) continue;
    if (message.role === "system") continue;

    const belongsToCurrentTurn = currentTurn != null &&
      messageIndex >= currentTurn.startMessageIndex;
    let turnIndex: number;
    let seqInTurn: number;
    let assignmentFallbackSegmentIndex: number | null = null;
    if (belongsToCurrentTurn) {
      turnIndex = currentTurn.turnIndex;
      currentTurnSeqInTurn += 1;
      seqInTurn = currentTurnSeqInTurn;
    } else {
      if (fallbackSegmentIndex === 0 || startsNewFallbackTurn(message)) {
        fallbackSegmentIndex += 1;
      }
      assignmentFallbackSegmentIndex = fallbackSegmentIndex;
      turnIndex = fallbackSegmentIndex;
      seqInTurn = 0;
    }

    rawAssignments.push({
      message,
      messageIndex,
      turnIndex,
      seqInTurn,
      anchoredToCurrentTurn: belongsToCurrentTurn,
      fallbackSegmentIndex: assignmentFallbackSegmentIndex,
    });
  }

  const fallbackTargetTurn = currentTurn
    ? currentTurn.turnIndex - 1
    : normalizePositiveInteger(input.latestTurnIndex);
  const fallbackTurnForSegment = buildFallbackTurnMapper(
    fallbackSegmentIndex,
    fallbackTargetTurn,
  );
  const seqByFallbackTurn = new Map<number, number>();
  let lastAssignedTimestampMs: number | null = null;

  return rawAssignments.map((assignment) => {
    const turnIndex = assignment.anchoredToCurrentTurn
      ? assignment.turnIndex
      : fallbackTurnForSegment(assignment.fallbackSegmentIndex ?? 1);
    const seqInTurn = assignment.anchoredToCurrentTurn
      ? assignment.seqInTurn
      : nextFallbackSeq(seqByFallbackTurn, turnIndex);
    const createdAt = nextOmAssignmentTimestamp({
      chatTimeline,
      role: normalizeCoreRole(assignment.message.role),
      turnIndex,
      seqInTurn,
      lastAssignedTimestampMs,
    });
    lastAssignedTimestampMs = createdAt.getTime();
    return {
      message: assignment.message,
      messageIndex: assignment.messageIndex,
      id: makeOmMessageId(input.sessionId, turnIndex, seqInTurn),
      turnIndex,
      seqInTurn,
      createdAt,
    };
  });
}

export function toOmDbMessage(
  message: CoreMessage,
  opts: {
    id: string;
    threadId: string;
    resourceId: string;
    createdAt: Date;
  },
): MastraDBMessage {
  const role = normalizeCoreRole(message.role);
  const text = coreMessageContentText(message.content);
  const createdAtMs = opts.createdAt.getTime();
  return {
    id: opts.id,
    role,
    threadId: opts.threadId,
    resourceId: opts.resourceId,
    createdAt: new Date(opts.createdAt),
    content: {
      format: 2,
      parts: text
        ? [{ type: "text", text, createdAt: createdAtMs }]
        : [],
      content: text,
    },
  } as MastraDBMessage;
}

export function pendingOmDbMessages(input: {
  sessionId: string;
  threadId: string;
  resourceId: string;
  messages: readonly CoreMessage[];
  chatHistory?: readonly ChatMessage[];
  cursor?: OmSidecarCursor | null;
  currentTurn?: {
    turnIndex: number;
    startMessageIndex: number;
  } | null;
}): { dbMessages: MastraDBMessage[]; lastCursor: OmSidecarCursor | null; ids: string[] } {
  const assignments = buildOmMessageAssignments({
    sessionId: input.sessionId,
    messages: input.messages,
    chatHistory: input.chatHistory,
    currentTurn: input.currentTurn,
  });
  const pending = assignments.filter((assignment) => {
    if (!input.cursor) return true;
    return compareOmCursor(assignment, input.cursor) > 0;
  });
  const dbMessages = pending.map((assignment) =>
    toOmDbMessage(assignment.message, {
      id: assignment.id,
      threadId: input.threadId,
      resourceId: input.resourceId,
      createdAt: assignment.createdAt,
    })
  );
  const last = pending.at(-1);
  return {
    dbMessages,
    lastCursor: last
      ? { turnIndex: last.turnIndex, seqInTurn: last.seqInTurn }
      : null,
    ids: pending.map((assignment) => assignment.id),
  };
}

export function allOmDbMessages(input: {
  sessionId: string;
  threadId: string;
  resourceId: string;
  messages: readonly CoreMessage[];
  chatHistory?: readonly ChatMessage[];
  currentTurn?: {
    turnIndex: number;
    startMessageIndex: number;
  } | null;
}): MastraDBMessage[] {
  return buildOmMessageAssignments({
    sessionId: input.sessionId,
    messages: input.messages,
    chatHistory: input.chatHistory,
    currentTurn: input.currentTurn,
  }).map((assignment) =>
    toOmDbMessage(assignment.message, {
      id: assignment.id,
      threadId: input.threadId,
      resourceId: input.resourceId,
      createdAt: assignment.createdAt,
    })
  );
}

export async function prepareOmContextForTurn(
  state: SessionState,
  requestContext?: RequestContext,
  options: PrepareOmContextOptions = {},
): Promise<OmPreparedContext> {
  const original: OmPreparedContext = {
    messagesForModel: state.messages,
    tailObservationPrompt: null,
    compressed: false,
    fullTokenEstimate: 0,
    projectedTokenEstimate: 0,
    removedMessageIds: [],
    observations: null,
  };
  if (!isOmSidecarEnabled()) return original;

  const threadId = state.threadId ?? state.sessionId;
  const resourceId = state.resourceId || QINGAGENT_RESOURCE_ID;
  const record = await getOmRecord({
    threadId,
    resourceId,
  }).catch((error) => {
    logger.warn("[omSidecar] failed to load OM record", {
      sessionId: state.sessionId,
      error: stringifyError(error),
    });
    return null;
  });
  const observations = record?.activeObservations?.trim() || null;
  const observedMessageIds = mergeObservedMessageIds(
    state.omObservedMessageIds,
    record?.observedMessageIds,
  );
  if (!sameStringArray(observedMessageIds, state.omObservedMessageIds ?? [])) {
    state.omObservedMessageIds = observedMessageIds;
    void schedulePersist(state, "om_sidecar:observed_ids").catch((error) =>
      logger.warn("[omSidecar] failed to persist observed ids", {
        sessionId: state.sessionId,
        error: stringifyError(error),
      }),
    );
  }

  let projection: OmProjectionResult = {
    messages: state.messages,
    compressed: false,
    fullTokenEstimate: countCoreMessageTokens(state.sessionId, state.messages),
    projectedTokenEstimate: 0,
    removedMessageIds: [],
  };
  projection.projectedTokenEstimate = projection.fullTokenEstimate;

  if (isOmCompressionEnabled()) {
    projection = buildOmCompressedProjection({
      sessionId: state.sessionId,
      messages: state.messages,
      chatHistory: state.chatHistory,
      observations,
      observedMessageIds,
      compressionAlreadyActive: state.omCompressionActive === true,
      latestTurnIndex: state.turnCounter,
      thresholdTokens: omCompressionThresholdTokens(),
      recentTurns: omCompressionRecentTurns(),
    });
    if (projection.compressed && state.omCompressionActive !== true) {
      if (options.allowCompressionActivation === false) {
        projection = {
          messages: state.messages,
          compressed: false,
          fullTokenEstimate: projection.fullTokenEstimate,
          projectedTokenEstimate: projection.fullTokenEstimate,
          removedMessageIds: [],
        };
      } else {
        state.omCompressionActive = true;
        recordOmSidecarSpan(state, "om_projection_switch", {
          modelId: resolveModelId(requestContext, "flash"),
          fullTokenEstimate: projection.fullTokenEstimate,
          projectedTokenEstimate: projection.projectedTokenEstimate,
          removedMessageCount: projection.removedMessageIds.length,
        });
        void schedulePersist(state, "om_projection:compression_latch").catch((error) =>
          logger.warn("[omSidecar] failed to persist compression latch", {
            sessionId: state.sessionId,
            error: stringifyError(error),
          }),
        );
      }
    }
  }

  return {
    messagesForModel: projection.messages,
    tailObservationPrompt: projection.compressed
      ? null
      : buildOmObservationsContent(observations),
    compressed: projection.compressed,
    fullTokenEstimate: projection.fullTokenEstimate,
    projectedTokenEstimate: projection.projectedTokenEstimate,
    removedMessageIds: projection.removedMessageIds,
    observations,
  };
}

export function buildOmCompressedProjection(input: OmProjectionInput): OmProjectionResult {
  const thresholdTokens = input.thresholdTokens ?? OM_DEFAULT_COMPRESS_THRESHOLD_TOKENS;
  const recentTurns = input.recentTurns ?? OM_DEFAULT_RECENT_TURNS;
  const fullTokenEstimate = countCoreMessageTokens(input.sessionId, input.messages);
  const observations = input.observations?.trim() || "";
  const observedIds = new Set(input.observedMessageIds);

  const activeLatch = input.compressionAlreadyActive === true;
  if (!observations || observedIds.size === 0) {
    return {
      messages: input.messages,
      compressed: activeLatch,
      fullTokenEstimate,
      projectedTokenEstimate: fullTokenEstimate,
      removedMessageIds: [],
    };
  }

  const shouldCompress =
    activeLatch || fullTokenEstimate > thresholdTokens;
  if (!shouldCompress) {
    return {
      messages: input.messages,
      compressed: false,
      fullTokenEstimate,
      projectedTokenEstimate: fullTokenEstimate,
      removedMessageIds: [],
    };
  }

  const assignments = buildOmMessageAssignments({
    sessionId: input.sessionId,
    messages: input.messages,
    chatHistory: input.chatHistory,
    latestTurnIndex: input.latestTurnIndex,
  });
  const byIndex = new Map(assignments.map((assignment) => [assignment.messageIndex, assignment]));
  const maxTurnIndex = assignments.reduce(
    (max, assignment) => Math.max(max, assignment.turnIndex),
    0,
  );
  const recentStartTurn = Math.max(1, maxTurnIndex - recentTurns + 1);
  const removedMessageIds: string[] = [];
  const kept: CoreMessage[] = [];

  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index]!;
    const assignment = byIndex.get(index);
    if (!assignment) {
      kept.push(message);
      continue;
    }
    const isRecent = assignment.turnIndex >= recentStartTurn;
    const isObserved = observedIds.has(assignment.id);
    if (!isRecent && isObserved) {
      removedMessageIds.push(assignment.id);
      continue;
    }
    kept.push(message);
  }

  if (removedMessageIds.length === 0) {
    return {
      messages: input.messages,
      compressed: activeLatch,
      fullTokenEstimate,
      projectedTokenEstimate: fullTokenEstimate,
      removedMessageIds,
    };
  }

  const projectionMessages = insertObservationProjectionMessage(kept, observations);
  return {
    messages: projectionMessages,
    compressed: true,
    fullTokenEstimate,
    projectedTokenEstimate: countCoreMessageTokens(input.sessionId, projectionMessages),
    removedMessageIds,
  };
}

export function scheduleOmSidecarAfterTurn(
  state: SessionState,
  requestContext?: RequestContext,
  options: OmTurnSnapshotOptions = {},
): void {
  if (!isOmSidecarEnabled()) return;
  const snapshot = createOmSidecarSnapshot(state, options);
  const requestContextSnapshot = createOmRequestContextSnapshot(requestContext, snapshot);
  const previous = omSidecarQueues.get(state.sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() =>
      runOmSidecarSnapshotAfterTurn(
        snapshot,
        requestContextSnapshot,
        (cursor) => commitOmSidecarCursor(state, snapshot, cursor),
        (ids) => commitOmObservedMessageIds(state, snapshot, ids),
      )
    )
    .catch((error) => {
      logger.warn("[omSidecar] background turn handoff failed", {
        sessionId: state.sessionId,
        error: stringifyError(error),
      });
    });
  const queued = next.finally(() => {
    if (omSidecarQueues.get(state.sessionId) === queued) {
      omSidecarQueues.delete(state.sessionId);
    }
  });
  omSidecarQueues.set(state.sessionId, queued);
}

export async function runOmSidecarAfterTurn(
  state: SessionState,
  requestContext?: RequestContext,
  snapshot = createOmSidecarSnapshot(state),
): Promise<void> {
  const requestContextSnapshot = createOmRequestContextSnapshot(requestContext, snapshot);
  await runOmSidecarSnapshotAfterTurn(
    snapshot,
    requestContextSnapshot,
    (cursor) => commitOmSidecarCursor(state, snapshot, cursor),
    (ids) => commitOmObservedMessageIds(state, snapshot, ids),
  );
}

async function runOmSidecarSnapshotAfterTurn(
  snapshot: OmSidecarTurnSnapshot,
  requestContext?: RequestContext,
  commitCursor?: OmCursorCommitter,
  commitObservedIds?: OmObservedIdsCommitter,
): Promise<void> {
  if (!isOmSidecarEnabled()) return;
  const storageThreadId = omSidecarThreadId(snapshot.threadId);
  const storageResourceId = omSidecarResourceId(snapshot.resourceId);
  const pending = pendingOmDbMessages({
    sessionId: snapshot.sessionId,
    threadId: storageThreadId,
    resourceId: storageResourceId,
    messages: snapshot.messages,
    chatHistory: snapshot.chatHistory,
    cursor: snapshot.cursor,
    currentTurn: snapshot.currentTurn,
  });
  if (pending.dbMessages.length === 0) return;

  const om = await getOmSidecar();
  if (!om) return;
  const stableContextMessages = allOmDbMessages({
    sessionId: snapshot.sessionId,
    threadId: storageThreadId,
    resourceId: storageResourceId,
    messages: snapshot.messages,
    chatHistory: snapshot.chatHistory,
    currentTurn: snapshot.currentTurn,
  });

  const modelId = resolveModelId(requestContext, "flash");
  recordOmSidecarSpan(snapshot, "om_sidecar_persist", {
    modelId,
    storageThreadId,
    storageResourceId,
    messageCount: pending.dbMessages.length,
    ids: pending.ids,
  });
  await om.persistMessages(pending.dbMessages, storageThreadId, storageResourceId);
  if (pending.lastCursor && commitCursor) await commitCursor(pending.lastCursor);

  let status = await om.getStatus({
    threadId: storageThreadId,
    resourceId: storageResourceId,
    messages: stableContextMessages,
  });
  await commitObservedIdsFromRecord(status.record, commitObservedIds);
  if (status.canActivate) {
    const activationResult = await om.activate({
      threadId: storageThreadId,
      resourceId: storageResourceId,
      messages: stableContextMessages,
    });
    await commitObservedIdsFromRecord(activationResult.record, commitObservedIds);
    if (activationResult.activatedMessageIds?.length) {
      await commitObservedIds?.(activationResult.activatedMessageIds);
    }
    recordOmSidecarSpan(snapshot, "om_sidecar_activate", {
      modelId,
      activated: activationResult.activated,
      activatedMessageCount: activationResult.activatedMessageIds?.length ?? 0,
    });
    status = await om.getStatus({
      threadId: storageThreadId,
      resourceId: storageResourceId,
      messages: stableContextMessages,
    });
    await commitObservedIdsFromRecord(status.record, commitObservedIds);
  }
  recordOmSidecarSpan(snapshot, "om_sidecar_status", {
    modelId,
    pendingTokens: status.pendingTokens,
    shouldBuffer: status.shouldBuffer,
    shouldObserve: status.shouldObserve,
    shouldReflect: status.shouldReflect,
    bufferedChunkCount: status.bufferedChunkCount,
  });

  if (status.shouldObserve) {
    const observeResult = await om.observe({
      threadId: storageThreadId,
      resourceId: storageResourceId,
      messages: stableContextMessages,
      requestContext,
    });
    await commitObservedIdsFromRecord(observeResult.record, commitObservedIds);
    return;
  }

  if (status.shouldBuffer) {
    await om.buffer({
      threadId: storageThreadId,
      resourceId: storageResourceId,
      messages: stableContextMessages,
      pendingTokens: status.pendingTokens,
      record: status.record,
      requestContext,
    });
  }

  if (status.shouldReflect) {
    await om.reflect(
      storageThreadId,
      storageResourceId,
      undefined,
      requestContext,
    );
  }
}

export async function getOmObservations(opts: {
  threadId: string;
  resourceId?: string;
}): Promise<string | undefined> {
  const om = await getOmSidecar();
  return om?.getObservations(
    omSidecarThreadId(opts.threadId),
    omSidecarResourceId(opts.resourceId || QINGAGENT_RESOURCE_ID),
  );
}

export async function getOmRecord(opts: {
  threadId: string;
  resourceId?: string;
}): Promise<ObservationalMemoryRecord | null> {
  const om = await getOmSidecar();
  if (!om) return null;
  return await om.getRecord(
    omSidecarThreadId(opts.threadId),
    omSidecarResourceId(opts.resourceId || QINGAGENT_RESOURCE_ID),
  );
}

export async function waitForOmSidecarBuffering(opts: {
  threadId: string;
  resourceId?: string;
  timeoutMs?: number;
}): Promise<void> {
  const om = await getOmSidecar();
  if (!om) return;
  await om.waitForBuffering(
    omSidecarThreadId(opts.threadId),
    omSidecarResourceId(opts.resourceId || QINGAGENT_RESOURCE_ID),
    opts.timeoutMs,
  );
}

function insertObservationProjectionMessage(
  messages: readonly CoreMessage[],
  observations: string,
): CoreMessage[] {
  const observationMessage = buildOmObservationsPromptMessage(
    observations,
    Number.POSITIVE_INFINITY,
  );
  const insertAt = firstNonSystemOrInternalIndex(messages);
  return [
    ...messages.slice(0, insertAt),
    observationMessage,
    ...messages.slice(insertAt),
  ];
}

function firstNonSystemOrInternalIndex(messages: readonly CoreMessage[]): number {
  const index = messages.findIndex((message) =>
    message.role !== "system" && !isInternalOmContextMessage(message)
  );
  return index >= 0 ? index : messages.length;
}

function startsNewFallbackTurn(message: CoreMessage): boolean {
  if (message.role !== "user") return false;
  return !isAuxiliaryUserMessage(message);
}

function isAuxiliaryUserMessage(message: CoreMessage): boolean {
  const text = coreMessageContentText(message.content).trimStart();
  return text.startsWith("[askUserAnswers:");
}

function createOmSidecarSnapshot(
  state: SessionState,
  options: OmTurnSnapshotOptions = {},
): OmSidecarTurnSnapshot {
  const turnIndex = normalizePositiveInteger(options.turnIndex);
  const startMessageIndex = normalizeNonNegativeInteger(options.turnStartMessageIndex);
  return {
    sessionId: state.sessionId,
    threadId: state.threadId ?? state.sessionId,
    resourceId: state.resourceId || QINGAGENT_RESOURCE_ID,
    messages: [...state.messages],
    chatHistory: [...state.chatHistory],
    cursor: state.omSidecarCursor ? { ...state.omSidecarCursor } : null,
    currentTurn: turnIndex != null && startMessageIndex != null
      ? { turnIndex, startMessageIndex }
      : null,
  };
}

function createOmRequestContextSnapshot(
  requestContext: RequestContext | undefined,
  snapshot: OmSidecarTurnSnapshot,
): RequestContext | undefined {
  if (!requestContext) return undefined;
  const entries: Array<[string, unknown]> = [
    [MASTRA_THREAD_ID_KEY, omSidecarThreadId(snapshot.threadId)],
    [MASTRA_RESOURCE_ID_KEY, omSidecarResourceId(snapshot.resourceId)],
    ["sessionId", snapshot.sessionId],
    ["origin", requestContext.get("origin") ?? "manual"],
    ["streamId", requestContext.get("streamId") ?? null],
    ["clientTraceId", requestContext.get("clientTraceId") ?? null],
  ];
  const modelOverrides = cloneJsonLikeValue(
    requestContext.get(MODEL_OVERRIDES_CONTEXT_KEY),
  );
  if (modelOverrides !== undefined) {
    entries.push([MODEL_OVERRIDES_CONTEXT_KEY, modelOverrides]);
  }
  return new RequestContext(entries);
}

function cloneJsonLikeValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ...(value as Record<string, unknown>) };
    }
    if (Array.isArray(value)) return [...value];
    return value;
  }
}

async function commitOmSidecarCursor(
  state: SessionState,
  snapshot: OmSidecarTurnSnapshot,
  cursor: OmSidecarCursor,
): Promise<void> {
  const currentCursor = state.omSidecarCursor ?? snapshot.cursor ?? null;
  if (currentCursor && compareOmCursor(cursor, currentCursor) <= 0) return;
  state.omSidecarCursor = cursor;
  await schedulePersist(state, "om_sidecar:cursor").catch((error) =>
    logger.warn("[omSidecar] failed to persist cursor", {
      sessionId: snapshot.sessionId,
      error: stringifyError(error),
    }),
  );
}

async function commitOmObservedMessageIds(
  state: SessionState,
  snapshot: OmSidecarTurnSnapshot,
  ids: readonly string[],
): Promise<void> {
  const merged = mergeObservedMessageIds(state.omObservedMessageIds, ids);
  if (sameStringArray(merged, state.omObservedMessageIds ?? [])) return;
  state.omObservedMessageIds = merged;
  await schedulePersist(state, "om_sidecar:observed_ids").catch((error) =>
    logger.warn("[omSidecar] failed to persist observed ids", {
      sessionId: snapshot.sessionId,
      error: stringifyError(error),
    }),
  );
}

async function commitObservedIdsFromRecord(
  record: unknown,
  commitObservedIds: OmObservedIdsCommitter | undefined,
): Promise<void> {
  if (!commitObservedIds) return;
  const ids = extractObservedMessageIds(record);
  if (ids.length === 0) return;
  await commitObservedIds(ids);
}

function extractObservedMessageIds(record: unknown): string[] {
  if (!record || typeof record !== "object") return [];
  const raw = (record as { observedMessageIds?: unknown }).observedMessageIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function mergeObservedMessageIds(
  ...sources: Array<Iterable<string> | null | undefined>
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const id of source) {
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function countCoreMessageTokens(
  sessionId: string,
  messages: readonly CoreMessage[],
): number {
  const dbMessages = messages.map((message, index) =>
    toOmDbMessage(message, {
      id: `${sessionId}-projection-${index}`,
      threadId: sessionId,
      resourceId: QINGAGENT_RESOURCE_ID,
      createdAt: deterministicOmTimestamp(0, index + 1),
    })
  );
  return tokenCounter.countMessages(dbMessages);
}

async function getOmSidecar(): Promise<ObservationalMemory | null> {
  if (!omSidecarPromise) {
    omSidecarPromise = createOmSidecar();
  }
  return await omSidecarPromise;
}

async function createOmSidecar(): Promise<ObservationalMemory | null> {
  try {
    const memoryStore = await getMemory().storage.getStore("memory");
    if (!memoryStore || memoryStore.supportsObservationalMemory !== true) {
      logger.warn("[omSidecar] memory store does not support observational memory");
      return null;
    }
    const om = new ObservationalMemory({
      storage: memoryStore,
      scope: "thread",
      model: ({ requestContext }: { requestContext?: RequestContext }) =>
        getObserverFlashModelFor(requestContext) as never,
      observation: {
        observeAttachments: false,
        messageTokens: 30_000,
      },
      reflection: {
        observationTokens: 40_000,
      },
      mastra,
      onDebugEvent: (event) => {
        logger.debug("[omSidecar] debug event", {
          type: event.type,
          threadId: event.threadId,
          resourceId: event.resourceId,
          pendingTokens: event.pendingTokens,
          threshold: event.threshold,
        });
      },
    });
    om.__registerMastra(mastra);
    return om;
  } catch (error) {
    logger.warn("[omSidecar] failed to create sidecar", { error: stringifyError(error) });
    return null;
  }
}

function getObserverFlashModelFor(
  requestContext?: RequestContext,
): RepairingModelRouterLanguageModel | RepairingAgentAnthropicModel {
  const { apiKey } = resolveDeepseekAuth(requestContext);
  const effectiveKey = apiKey || qingagentModelConfig.apiKey;
  const baseUrl = resolveBaseUrl(requestContext);
  const evict = () => {
    if (observerModelCache.size >= OBSERVER_MODEL_CACHE_LIMIT) {
      const oldest = observerModelCache.keys().next().value;
      if (oldest !== undefined) observerModelCache.delete(oldest);
    }
  };

  if (resolveProtocol(requestContext) === "anthropic") {
    const anthModel = resolveModelId(requestContext, "flash");
    const anthKey = `anthropic ${baseUrl} ${anthModel} ${effectiveKey}`;
    let model = observerModelCache.get(anthKey);
    if (!model) {
      model = wrapToolCallRepairingModel(
        createAnthropicV5({ baseURL: anthropicBaseUrl(baseUrl), apiKey: effectiveKey })(
          anthModel,
        ) as RepairingAgentAnthropicModel,
      );
      evict();
      observerModelCache.set(anthKey, model);
    }
    return wrapModernModelUsage(model, {
      requestContext,
      callSite: "omSidecar",
      modelId: anthModel,
      keyOrigin: resolveDeepseekAuth(requestContext).origin,
    });
  }

  const modelId = resolveDeepseekRouterModelId(requestContext, "flash");
  const cacheKey = `${baseUrl}|${modelId}|${effectiveKey}`;
  let model = observerModelCache.get(cacheKey);
  if (!model) {
    model = createRepairingQingagentModel({ id: modelId, url: baseUrl, apiKey: effectiveKey });
    evict();
    observerModelCache.set(cacheKey, model);
  }
  return wrapModernModelUsage(model, {
    requestContext,
    callSite: "omSidecar",
    modelId: resolveModelId(requestContext, "flash"),
    keyOrigin: resolveDeepseekAuth(requestContext).origin,
  });
}

function normalizeCurrentTurn(
  currentTurn: {
    turnIndex: number;
    startMessageIndex: number;
  } | null | undefined,
): { turnIndex: number; startMessageIndex: number } | null {
  const turnIndex = normalizePositiveInteger(currentTurn?.turnIndex);
  const startMessageIndex = normalizeNonNegativeInteger(currentTurn?.startMessageIndex);
  if (turnIndex == null || startMessageIndex == null) return null;
  return { turnIndex, startMessageIndex };
}

function buildFallbackTurnMapper(
  segmentCount: number,
  targetLatestTurn: number | null,
): (segmentIndex: number) => number {
  if (segmentCount <= 0) return () => 1;
  if (targetLatestTurn == null || targetLatestTurn <= 0) {
    return (segmentIndex) => Math.max(1, Math.floor(segmentIndex));
  }
  if (segmentCount <= targetLatestTurn) {
    const offset = targetLatestTurn - segmentCount;
    return (segmentIndex) => Math.max(1, Math.floor(segmentIndex) + offset);
  }
  const overflow = segmentCount - targetLatestTurn;
  return (segmentIndex) => Math.max(1, Math.floor(segmentIndex) - overflow);
}

function nextFallbackSeq(seqByTurn: Map<number, number>, turnIndex: number): number {
  const next = (seqByTurn.get(turnIndex) ?? 0) + 1;
  seqByTurn.set(turnIndex, next);
  return next;
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function normalizeNonNegativeInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function normalizeCoreRole(role: CoreMessage["role"]): "user" | "assistant" | "system" {
  if (role === "system" || role === "user" || role === "assistant") return role;
  return "assistant";
}

function coreMessageContentText(content: CoreMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map(corePartText).filter(Boolean).join("\n");
}

function corePartText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const record = part as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.type === "string") {
    if (record.type === "image") return "[image omitted]";
    if (record.type === "file") return "[file omitted]";
    if (record.type === "tool-result") return "[tool result omitted]";
    if (record.type === "tool-call") return "[tool call omitted]";
  }
  return "";
}

function buildChatTimeline(chatHistory: readonly ChatMessage[]): Array<{
  role: "user" | "assistant";
  ts: Date;
  used: boolean;
}> {
  return chatHistory.flatMap((message) => {
    const role = message.role.kind === "user"
      ? "user"
      : message.role.kind === "agent"
        ? "assistant"
        : null;
    if (!role) return [];
    const ts = new Date(message.ts);
    return [{ role, ts: Number.isNaN(ts.getTime()) ? new Date(0) : ts, used: false }];
  });
}

function nextChatTimestamp(
  timeline: Array<{ role: "user" | "assistant"; ts: Date; used: boolean }>,
  role: "user" | "assistant" | "system",
): Date | null {
  if (role === "system") return null;
  const found = timeline.find((item) => !item.used && item.role === role);
  if (!found) return null;
  found.used = true;
  return new Date(found.ts);
}

function nextOmAssignmentTimestamp(opts: {
  chatTimeline: Array<{ role: "user" | "assistant"; ts: Date; used: boolean }>;
  role: "user" | "assistant" | "system";
  turnIndex: number;
  seqInTurn: number;
  lastAssignedTimestampMs: number | null;
}): Date {
  const fromChat = nextChatTimestamp(opts.chatTimeline, opts.role);
  const fallback = fromChat ?? deterministicOmTimestamp(opts.turnIndex, opts.seqInTurn);
  const fallbackMs = fallback.getTime();
  if (opts.lastAssignedTimestampMs == null || fallbackMs > opts.lastAssignedTimestampMs) {
    return fallback;
  }
  return new Date(opts.lastAssignedTimestampMs + 1);
}

function deterministicOmTimestamp(turnIndex: number, seqInTurn: number): Date {
  return new Date(Date.UTC(2020, 0, 1, 0, 0, 0, 0) + turnIndex * 1_000 + seqInTurn);
}

function recordOmSidecarSpan(
  target: Pick<SessionState, "sessionId" | "threadId" | "resourceId">,
  name: string,
  output: Record<string, unknown>,
): void {
  try {
    const instance = getObservability()?.getDefaultInstance();
    if (!instance) return;
    const traceId = sessionIdToTraceId(target.sessionId);
    const span = instance.startSpan({
      type: SpanType.GENERIC,
      name,
      ...(traceId ? { traceId } : {}),
      metadata: {
        eventKind: name,
        sessionId: target.sessionId,
        threadId: target.threadId,
        resourceId: target.resourceId,
        sidecar: "om",
      },
    });
    span.end({ output });
  } catch (error) {
    logger.warn("[omSidecar] span failed", {
      sessionId: target.sessionId,
      error: stringifyError(error),
    });
  }
}

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on";
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
