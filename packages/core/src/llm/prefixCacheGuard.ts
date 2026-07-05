import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type PrefixCacheGuardLineage = "turn" | "resume";

export type PrefixCacheGuardContext = {
  sessionId: string;
  lineage: PrefixCacheGuardLineage;
  scopeId?: string;
  allowedToolAdditions?: string[];
};

type PrefixCacheGuardMode = "off" | "warn" | "strict";

type PromptSegment = {
  role: string;
  hash: string;
};

type GuardSnapshot = {
  sessionId: string;
  lineage: PrefixCacheGuardLineage;
  scopeId: string;
  fullHash: string;
  toolsHash: string;
  toolNames: string[];
  toolHashesByName: Record<string, string>;
  toolSearchActivatedNames: string[];
  allowedToolAdditions: string[];
  segments: PromptSegment[];
};

type GuardLineageState = {
  sessionId: string;
  lineage: PrefixCacheGuardLineage;
  currentScopeId: string;
  firstSnapshot: GuardSnapshot;
  lastSnapshot: GuardSnapshot;
};

export type PrefixCacheGuardDiff = {
  sessionId: string;
  lineage: PrefixCacheGuardLineage;
  reason: "prompt_prefix_mismatch" | "tools_mismatch";
  firstDiffIndex: number | null;
  prevRole: string | null;
  curRole: string | null;
  prevLength: number;
  curLength: number;
  prevHash: string;
  curHash: string;
  prevToolsHash: string;
  curToolsHash: string;
};

export type PrefixCacheGuardResult =
  | { status: "skipped"; reason: "off" | "missing_context" }
  | { status: "recorded"; snapshot: GuardSnapshot }
  | { status: "passed"; snapshot: GuardSnapshot }
  | { status: "warned"; diff: PrefixCacheGuardDiff };

export class PrefixCacheGuardError extends Error {
  constructor(public readonly diff: PrefixCacheGuardDiff) {
    super(
      `Prefix cache guard failed for session ${diff.sessionId} (${diff.lineage}): ${diff.reason}`,
    );
    this.name = "PrefixCacheGuardError";
  }
}

const MAX_SESSIONS = 200;
const guardStorage = new AsyncLocalStorage<PrefixCacheGuardContext>();
const snapshots = new Map<string, GuardLineageState>();
const sessionOrder = new Map<string, true>();
const DEFAULT_SCOPE_ID = "__default__";

export const guardContext = {
  run<T>(context: PrefixCacheGuardContext, fn: () => T): T {
    return guardStorage.run(context, fn);
  },
  getStore(): PrefixCacheGuardContext | undefined {
    return guardStorage.getStore();
  },
};

export async function* withPrefixCacheGuardContext<T, TReturn, TNext = unknown>(
  context: PrefixCacheGuardContext,
  factory: () => AsyncGenerator<T, TReturn, TNext>,
): AsyncGenerator<T, TReturn, TNext> {
  const iterator = guardContext.run(context, factory);
  let completed = false;
  let input: TNext | undefined;
  let pending: IteratorResult<T, TReturn> | undefined;
  try {
    while (true) {
      const next = pending ??
        await guardContext.run(context, () => iterator.next(input as TNext));
      pending = undefined;
      if (next.done) {
        completed = true;
        return next.value;
      }
      try {
        input = yield next.value;
      } catch (err) {
        input = undefined;
        if (!iterator.throw) throw err;
        pending = await guardContext.run(context, () => iterator.throw!(err));
      }
    }
  } finally {
    if (!completed) {
      await guardContext.run(context, () =>
        iterator.return?.(undefined as unknown as TReturn)
      );
    }
  }
}

export function guardReset(
  sessionId: string,
  reason: string,
  lineage?: PrefixCacheGuardLineage,
): void {
  void reason;
  if (lineage) {
    snapshots.delete(snapshotKey(sessionId, lineage));
    if (
      !snapshots.has(snapshotKey(sessionId, "turn")) &&
      !snapshots.has(snapshotKey(sessionId, "resume"))
    ) {
      sessionOrder.delete(sessionId);
    }
    return;
  }
  snapshots.delete(snapshotKey(sessionId, "turn"));
  snapshots.delete(snapshotKey(sessionId, "resume"));
  sessionOrder.delete(sessionId);
}

export function guardBeforeProviderCall(options: unknown): PrefixCacheGuardResult {
  const mode = getGuardMode();
  if (mode === "off") return { status: "skipped", reason: "off" };

  const context = guardStorage.getStore();
  if (!context?.sessionId) return { status: "skipped", reason: "missing_context" };

  const snapshot = buildSnapshot(context, options);
  const key = snapshotKey(context.sessionId, context.lineage);
  const previous = snapshots.get(key);

  if (!previous) {
    touchSnapshot(key, createLineageState(context, snapshot));
    return { status: "recorded", snapshot };
  }

  const currentScopeId = getScopeId(context);
  const baseline = previous.currentScopeId === currentScopeId
    ? previous.lastSnapshot
    : previous.firstSnapshot;
  const diff = compareSnapshots(baseline, snapshot);
  if (!diff) {
    touchSnapshot(key, advanceLineageState(previous, context, snapshot));
    return { status: "passed", snapshot };
  }

  touchSnapshot(key, createLineageState(context, snapshot));

  if (mode === "strict") throw new PrefixCacheGuardError(diff);

  console.warn("[qingagent prefix cache guard] prompt prefix changed", diff);
  return { status: "warned", diff };
}

export function __resetPrefixCacheGuardForTest(): void {
  snapshots.clear();
  sessionOrder.clear();
}

export function __getPrefixCacheGuardSizeForTest(): number {
  return sessionOrder.size;
}

export function __getPrefixCacheGuardModeForTest(): PrefixCacheGuardMode {
  return getGuardMode();
}

function getGuardMode(): PrefixCacheGuardMode {
  const raw = (
    process.env.QINGAGENT_PREFIX_CACHE_GUARD ??
    (process.env.CI === "true" ? "strict" : "warn")
  ).toLowerCase();
  if (raw === "off" || raw === "0" || raw === "false") return "off";
  if (raw === "strict") return "strict";
  return "warn";
}

function snapshotKey(sessionId: string, lineage: PrefixCacheGuardLineage): string {
  return `${sessionId}:${lineage}`;
}

function touchSnapshot(key: string, state: GuardLineageState): void {
  snapshots.delete(key);
  snapshots.set(key, state);
  sessionOrder.delete(state.sessionId);
  sessionOrder.set(state.sessionId, true);
  while (sessionOrder.size > MAX_SESSIONS) {
    const oldestSessionId = sessionOrder.keys().next().value as string | undefined;
    if (!oldestSessionId) break;
    sessionOrder.delete(oldestSessionId);
    snapshots.delete(snapshotKey(oldestSessionId, "turn"));
    snapshots.delete(snapshotKey(oldestSessionId, "resume"));
  }
}

function getScopeId(context: PrefixCacheGuardContext): string {
  return context.scopeId ?? DEFAULT_SCOPE_ID;
}

function createLineageState(
  context: PrefixCacheGuardContext,
  snapshot: GuardSnapshot,
): GuardLineageState {
  return {
    sessionId: context.sessionId,
    lineage: context.lineage,
    currentScopeId: getScopeId(context),
    firstSnapshot: snapshot,
    lastSnapshot: snapshot,
  };
}

function advanceLineageState(
  previous: GuardLineageState,
  context: PrefixCacheGuardContext,
  snapshot: GuardSnapshot,
): GuardLineageState {
  const currentScopeId = getScopeId(context);
  if (previous.currentScopeId === currentScopeId) {
    return {
      ...previous,
      lastSnapshot: snapshot,
    };
  }
  return createLineageState(context, snapshot);
}

function buildSnapshot(
  context: PrefixCacheGuardContext,
  options: unknown,
): GuardSnapshot {
  const prompt = readProperty(options, "prompt");
  const rawMessages = Array.isArray(prompt) ? prompt : prompt === undefined ? [] : [prompt];
  const segments = rawMessages
    .filter(isStableSystemPromptMessage)
    .map((message) => {
      const role = readStringProperty(message, "role") ?? "unknown";
      return {
        role,
        hash: hashPrompt(readProperty(message, "content") ?? message),
      };
    });
  const toolsHash = hashStable(normalizeTools(readProperty(options, "tools")));
  const toolNames = normalizeToolNames(readProperty(options, "tools"));
  const toolHashesByName = normalizeToolHashesByName(readProperty(options, "tools"));
  const fullHash = hashStable({
    segments,
    toolsHash,
  });
  return {
    sessionId: context.sessionId,
    lineage: context.lineage,
    scopeId: getScopeId(context),
    fullHash,
    toolsHash,
    toolNames,
    toolHashesByName,
    toolSearchActivatedNames: extractToolSearchActivatedNames(rawMessages),
    allowedToolAdditions: Array.from(new Set(context.allowedToolAdditions ?? [])).sort(),
    segments,
  };
}

function isStableSystemPromptMessage(message: unknown): boolean {
  return readStringProperty(message, "role") === "system";
}

function compareSnapshots(
  previous: GuardSnapshot,
  current: GuardSnapshot,
): PrefixCacheGuardDiff | null {
  const firstDiffIndex = findFirstPromptDiff(previous.segments, current.segments);
  const promptIsSame =
    previous.segments.length === current.segments.length && firstDiffIndex === null;
  if (!promptIsSame) {
    return buildDiff(previous, current, "prompt_prefix_mismatch", firstDiffIndex);
  }
  if (previous.toolsHash !== current.toolsHash) {
    if (isAllowedToolSearchToolsChange(previous, current)) return null;
    return buildDiff(previous, current, "tools_mismatch", null);
  }
  return null;
}

function isAllowedToolSearchToolsChange(
  previous: GuardSnapshot,
  current: GuardSnapshot,
): boolean {
  const previousNames = new Set(previous.toolNames);
  const currentNames = new Set(current.toolNames);
  for (const name of previousNames) {
    if (!currentNames.has(name)) return false;
    if (previous.toolHashesByName[name] !== current.toolHashesByName[name]) return false;
  }
  const additions = current.toolNames.filter((name) => !previousNames.has(name));
  if (additions.length === 0) return false;
  const allowed = new Set([
    ...current.toolSearchActivatedNames,
    ...current.allowedToolAdditions,
  ]);
  return additions.every((name) => allowed.has(name));
}

function findFirstPromptDiff(
  previous: PromptSegment[],
  current: PromptSegment[],
): number | null {
  const len = Math.min(previous.length, current.length);
  for (let index = 0; index < len; index += 1) {
    if (
      previous[index]?.role !== current[index]?.role ||
      previous[index]?.hash !== current[index]?.hash
    ) {
      return index;
    }
  }
  return previous.length > current.length ? len : null;
}

function buildDiff(
  previous: GuardSnapshot,
  current: GuardSnapshot,
  reason: PrefixCacheGuardDiff["reason"],
  firstDiffIndex: number | null,
): PrefixCacheGuardDiff {
  const diffIndex = firstDiffIndex ?? Math.min(previous.segments.length, current.segments.length);
  return {
    sessionId: current.sessionId,
    lineage: current.lineage,
    reason,
    firstDiffIndex,
    prevRole: previous.segments[diffIndex]?.role ?? null,
    curRole: current.segments[diffIndex]?.role ?? null,
    prevLength: previous.segments.length,
    curLength: current.segments.length,
    prevHash: previous.fullHash,
    curHash: current.fullHash,
    prevToolsHash: previous.toolsHash,
    curToolsHash: current.toolsHash,
  };
}

function normalizeTools(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tool) => stableClone(tool))
    .sort((left, right) => toolSortKey(left).localeCompare(toolSortKey(right)));
}

function normalizeToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((tool) => readStringProperty(tool, "name") ?? readStringProperty(tool, "id"))
        .filter((name): name is string => Boolean(name)),
    ),
  ).sort();
}

function normalizeToolHashesByName(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const entries: Array<[string, string]> = [];
  for (const tool of value) {
    const name = readStringProperty(tool, "name") ?? readStringProperty(tool, "id");
    if (!name) continue;
    entries.push([name, hashStable(tool)]);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function toolSortKey(tool: unknown): string {
  const type = readStringProperty(tool, "type") ?? "";
  const name = readStringProperty(tool, "name") ?? "";
  const id = readStringProperty(tool, "id") ?? "";
  return `${type}:${name}:${id}:${stableStringify(tool)}`;
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function extractToolSearchActivatedNames(messages: unknown[]): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    collectToolSearchActivatedNames(message, names);
  }
  return Array.from(names).sort();
}

function collectToolSearchActivatedNames(value: unknown, names: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectToolSearchActivatedNames(item, names);
    return;
  }
  const record = value as Record<string, unknown>;
  const invocation = record.toolInvocation;
  if (invocation && typeof invocation === "object") {
    const invocationRecord = invocation as Record<string, unknown>;
    const toolName = invocationRecord.toolName;
    if (
      (toolName === "search_tools" || toolName === "load_tool") &&
      invocationRecord.state === "result"
    ) {
      for (const name of extractActivatedToolNames(invocationRecord.result)) {
        names.add(name);
      }
    }
  }
  if (record.type === "tool-result") {
    const toolName = record.toolName;
    if (toolName === "search_tools" || toolName === "load_tool") {
      for (const name of extractActivatedToolNames(record.result)) {
        names.add(name);
      }
      for (const name of extractActivatedToolNames(record.output)) {
        names.add(name);
      }
    }
  }
  if (record.role === "tool") {
    for (const name of extractActivatedToolNames(record.content)) {
      names.add(name);
    }
  }
  for (const child of Object.values(record)) {
    collectToolSearchActivatedNames(child, names);
  }
}

function extractActivatedToolNames(result: unknown): string[] {
  if (typeof result === "string") {
    try {
      return extractActivatedToolNames(JSON.parse(result));
    } catch {
      const names = result.match(/"name"\s*:\s*"([^"]+)"/g)
        ?.map((part) => part.match(/"name"\s*:\s*"([^"]+)"/)?.[1])
        .filter((name): name is string => Boolean(name));
      return names ?? [];
    }
  }
  if (Array.isArray(result)) {
    return result.flatMap((entry) => extractActivatedToolNames(entry));
  }
  if (!result || typeof result !== "object") return [];
  const names: string[] = [];
  const record = result as Record<string, unknown>;
  const directName = record.name;
  if (typeof directName === "string") names.push(directName);
  const results = record.results;
  if (Array.isArray(results)) {
    for (const entry of results) {
      if (entry && typeof entry === "object") {
        const name = (entry as { name?: unknown }).name;
        if (typeof name === "string") names.push(name);
      }
    }
  }
  const loaded = record.loaded;
  if (Array.isArray(loaded)) {
    for (const name of loaded) {
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

function hashPrompt(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value, { stripProviderOptions: true }))
    .digest("hex");
}

type StableCloneOptions = {
  stripProviderOptions?: boolean;
};

function stableStringify(value: unknown, options: StableCloneOptions = {}): string {
  return JSON.stringify(stableClone(value, new WeakSet<object>(), options));
}

function stableClone(
  value: unknown,
  seen = new WeakSet<object>(),
  options: StableCloneOptions = {},
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "undefined") return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "symbol") return { $type: "symbol", value: String(value) };
  if (typeof value === "function") return { $type: "function" };
  if (value instanceof Date) return { $type: "Date", value: value.toISOString() };
  if (value instanceof URL) return { $type: "URL", value: value.toString() };
  if (value instanceof RegExp) {
    return { $type: "RegExp", source: value.source, flags: value.flags };
  }
  if (value instanceof Uint8Array) {
    return {
      $type: "Uint8Array",
      byteLength: value.byteLength,
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  }
  if (Array.isArray(value)) return value.map((item) => stableClone(item, seen, options));
  if (typeof value === "object") {
    if (seen.has(value)) return { $type: "circular" };
    seen.add(value);
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (options.stripProviderOptions && key === "providerOptions") continue;
      output[key] = stableClone(record[key], seen, options);
    }
    seen.delete(value);
    return output;
  }
  return String(value);
}

function readProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function readStringProperty(value: unknown, key: string): string | undefined {
  const raw = readProperty(value, key);
  return typeof raw === "string" ? raw : undefined;
}
