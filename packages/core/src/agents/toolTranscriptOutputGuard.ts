import type {
  OutputProcessor,
  ProcessOutputStepArgs,
  ProcessOutputStreamArgs,
} from "@mastra/core/processors";
import type { ChunkType } from "@mastra/core/stream";

export const FAKE_TOOL_EXECUTION_WARN_SIGNATURE =
  "fake_tool_execution_zero_tool_calls";

const REPROCESS_PART_KEY = "__mastraReprocessPart";
const TOOL_TRANSCRIPT_MARKERS = ["[tool-result]\n", "[tool-result]\r\n"] as const;
const COMPLETE_TOOL_TRANSCRIPT_RE = /^\[tool-result\]\r?\ntoolName: [^\r\n]+\r?\ntoolCallId: [^\r\n]+\r?\nargs: [^\r\n]*\r?\nresult: [^\r\n]*\r?\n/u;
const EOF_TOOL_TRANSCRIPT_RE = /^\[tool-result\]\r?\ntoolName: [^\r\n]+\r?\ntoolCallId: [^\r\n]+\r?\nargs: [^\r\n]*\r?\nresult: [^\r\n]*$/u;

// 只判定明确声称“文档修改已完成”的短句；解释方案、讨论工具、尚未修改等文本不命中。
const DRAFT_COMPLETION_CLAIM_RE = /(?:^|[。！？\n])\s*(?:好的?[，,]\s*)?(?:已|已经)(?:按(?:照)?[^，。！？\n]{0,24})?(?:将|把)?[^，。！？\n]{0,40}(?:(?:修改|替换|更新|编辑|调整)(?:完成|完毕|成功|好了)|(?:改|换)(?:成|好了))|(?:^|[。！？\n])\s*(?:好的?[，,]\s*)?(?:已|已经)(?:成功)?完成(?:了)?[^，。！？\n]{0,16}(?:修改|替换|更新|编辑|调整)/u;

const STATE_BUFFER = "toolTranscriptGuardBuffer";
const STATE_BUFFER_AT_LINE_START = "toolTranscriptGuardBufferAtLineStart";
const STATE_SUPPRESS_STEP = "toolTranscriptGuardSuppressStep";
const STATE_DETECTED_STEP = "toolTranscriptGuardDetectedStep";
const STATE_TOOL_CALL_IDS = "toolTranscriptGuardToolCallIds";
const STATE_LAST_TEXT_PART = "toolTranscriptGuardLastTextPart";

type GuardState = Record<string, unknown>;

function readBuffer(state: GuardState): string {
  return typeof state[STATE_BUFFER] === "string" ? state[STATE_BUFFER] : "";
}

function bufferStartsAtLineStart(state: GuardState): boolean {
  return state[STATE_BUFFER_AT_LINE_START] !== false;
}

function setBuffer(
  state: GuardState,
  value: string,
  atLineStart: boolean,
): void {
  if (value) state[STATE_BUFFER] = value;
  else delete state[STATE_BUFFER];
  state[STATE_BUFFER_AT_LINE_START] = atLineStart;
}

function isLineStart(text: string, index: number, startsAtLineStart: boolean): boolean {
  return index === 0 ? startsAtLineStart : text[index - 1] === "\n";
}

function markerRelation(tail: string): boolean {
  return TOOL_TRANSCRIPT_MARKERS.some(
    (marker) => marker.startsWith(tail) || tail.startsWith(marker),
  );
}

function findPotentialMarkerStart(
  text: string,
  startsAtLineStart: boolean,
): number {
  for (let index = 0; index < text.length; index += 1) {
    if (!isLineStart(text, index, startsAtLineStart)) continue;
    if (markerRelation(text.slice(index))) return index;
  }
  return -1;
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function isPotentialToolTranscriptPrefix(text: string): boolean {
  const firstNewline = text.indexOf("\n");
  if (firstNewline < 0) return markerRelation(text);
  if (stripTrailingCarriageReturn(text.slice(0, firstNewline)) !== "[tool-result]") {
    return false;
  }

  const rest = text.slice(firstNewline + 1);
  const lines = rest.split("\n");
  const endsWithNewline = rest.endsWith("\n");
  const fieldPrefixes = ["toolName: ", "toolCallId: ", "args: ", "result: "];
  if (lines.length > fieldPrefixes.length) return false;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = stripTrailingCarriageReturn(lines[index]!);
    const prefix = fieldPrefixes[index]!;
    const lineIsComplete = index < lines.length - 1 || endsWithNewline;
    if (!lineIsComplete) {
      return prefix.startsWith(rawLine) || rawLine.startsWith(prefix);
    }
    if (!rawLine.startsWith(prefix)) return false;
    if (index < 2 && rawLine.length === prefix.length) return false;
  }
  return true;
}

function updateNextLineStart(current: boolean, consumed: string): boolean {
  if (!consumed) return current;
  return consumed.endsWith("\n");
}

function filterText(
  state: GuardState,
  incoming: string,
  eof: boolean,
): string {
  if (state[STATE_SUPPRESS_STEP] === true) {
    setBuffer(state, "", true);
    return "";
  }

  let buffer = readBuffer(state) + incoming;
  let startsAtLineStart = bufferStartsAtLineStart(state);
  let visible = "";

  while (buffer) {
    const markerStart = findPotentialMarkerStart(buffer, startsAtLineStart);
    if (markerStart < 0) {
      visible += buffer;
      startsAtLineStart = updateNextLineStart(startsAtLineStart, buffer);
      buffer = "";
      break;
    }

    if (markerStart > 0) {
      const safePrefix = buffer.slice(0, markerStart);
      visible += safePrefix;
      startsAtLineStart = updateNextLineStart(startsAtLineStart, safePrefix);
      buffer = buffer.slice(markerStart);
    }

    const completeMatch = COMPLETE_TOOL_TRANSCRIPT_RE.exec(buffer);
    const eofMatch = eof ? EOF_TOOL_TRANSCRIPT_RE.exec(buffer) : null;
    if (completeMatch || eofMatch) {
      // 命中后整个 attempt 的余下文本也不再上屏；processOutputStep 会基于本轮
      // 真实 tool-call 计数决定是否让 Mastra 重试。
      state[STATE_DETECTED_STEP] = true;
      state[STATE_SUPPRESS_STEP] = true;
      buffer = "";
      startsAtLineStart = true;
      break;
    }

    if (!eof && isPotentialToolTranscriptPrefix(buffer)) break;

    // 行首出现同名标记但后续字段不符合固定五行协议：它是普通讨论文本。
    visible += buffer[0]!;
    startsAtLineStart = false;
    buffer = buffer.slice(1);
  }

  setBuffer(state, buffer, startsAtLineStart);
  return visible;
}

function cloneTextPart(part: ChunkType, text: string): ChunkType {
  const payload = "payload" in part && part.payload && typeof part.payload === "object"
    ? part.payload as Record<string, unknown>
    : {};
  return {
    ...part,
    type: "text-delta",
    payload: { ...payload, text },
  } as ChunkType;
}

function actualToolCallIds(state: GuardState): Set<string> {
  const existing = state[STATE_TOOL_CALL_IDS];
  if (existing instanceof Set) return existing as Set<string>;
  const ids = new Set<string>();
  state[STATE_TOOL_CALL_IDS] = ids;
  return ids;
}

function recordToolCallFromPart(state: GuardState, part: ChunkType): void {
  if (part.type !== "tool-call") return;
  const payload = part.payload as unknown as Record<string, unknown>;
  if (typeof payload.toolCallId === "string" && payload.toolCallId) {
    actualToolCallIds(state).add(payload.toolCallId);
  }
}

function requestContextValue(
  args: Pick<ProcessOutputStepArgs, "requestContext">,
  key: string,
): unknown {
  try {
    return args.requestContext?.get(key);
  } catch {
    return undefined;
  }
}

function resetStepState(state: GuardState): void {
  delete state[STATE_BUFFER];
  state[STATE_BUFFER_AT_LINE_START] = true;
  delete state[STATE_SUPPRESS_STEP];
  delete state[STATE_DETECTED_STEP];
  delete state[STATE_LAST_TEXT_PART];
}

export class ToolTranscriptOutputGuard {
  readonly id = "tool-transcript-output-guard";
  readonly name = "Tool Transcript Output Guard";

  async processOutputStream(
    args: ProcessOutputStreamArgs,
  ): Promise<ChunkType | null | undefined> {
    const { part, state } = args;
    recordToolCallFromPart(state, part);

    if (part.type === "text-delta") {
      state[STATE_LAST_TEXT_PART] = part;
      const visible = filterText(state, part.payload.text, false);
      return visible ? cloneTextPart(part, visible) : null;
    }

    const visible = filterText(state, "", true);
    if (!visible) return part;
    const lastTextPart = state[STATE_LAST_TEXT_PART];
    if (!lastTextPart || typeof lastTextPart !== "object") return part;

    // Mastra 1.49.0 的公开 Processor 接口一次只能返回一个 part；runner 约定用此
    // well-known key 先发净化后的尾文本，再把当前非文本 part 重走完整 processor 链。
    state[REPROCESS_PART_KEY] = part;
    return cloneTextPart(lastTextPart as ChunkType, visible);
  }

  processOutputStep(args: ProcessOutputStepArgs) {
    const ids = actualToolCallIds(args.state);
    for (const toolCall of args.toolCalls ?? []) {
      if (toolCall.toolCallId) ids.add(toolCall.toolCallId);
    }

    const transcriptDetected = args.state[STATE_DETECTED_STEP] === true;
    const completionClaimDetected = typeof args.text === "string"
      && DRAFT_COMPLETION_CLAIM_RE.test(args.text);
    const fakeExecutionDetected = ids.size === 0
      && (transcriptDetected || completionClaimDetected);

    if (!fakeExecutionDetected) {
      resetStepState(args.state);
      return args.messages;
    }

    const evidence = transcriptDetected ? "tool_transcript" : "completion_claim";
    console.warn(`[${FAKE_TOOL_EXECUTION_WARN_SIGNATURE}]`, {
      signature: FAKE_TOOL_EXECUTION_WARN_SIGNATURE,
      sessionId: requestContextValue(args, "sessionId") ?? null,
      streamId: requestContextValue(args, "streamId") ?? null,
      stepNumber: args.stepNumber,
      retryCount: args.retryCount,
      actualToolCallCount: ids.size,
      evidence,
    });
    resetStepState(args.state);

    if (args.retryCount < 1) {
      args.abort(
        "回复声称已修改文档，但本轮没有真实工具调用。请实际调用所需工具完成任务，不要在正文中模拟工具记录。",
        {
          retry: true,
          metadata: { signature: FAKE_TOOL_EXECUTION_WARN_SIGNATURE },
        },
      );
    }
    return args.messages;
  }
}

export const TOOL_TRANSCRIPT_OUTPUT_GUARD =
  new ToolTranscriptOutputGuard() satisfies OutputProcessor;
