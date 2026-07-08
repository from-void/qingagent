import type { BridgeFrame } from "@qingagent/contract-ts";

export interface FrameLogExportEntry {
  seq: number;
  epoch: number;
  generation: number;
  frame: BridgeFrame | {
    kind: string;
    data: Record<string, unknown>;
  };
}

/** 把 FrameLog 导出条目压缩为可读摘要序列,输入输出都是 FrameLogExportEntry 形状的数组。 */
export function aggregateFrameLogEntries(entries: FrameLogExportEntry[]): unknown[] {
  const out: FrameLogExportEntry[] = [];
  let i = 0;
  while (i < entries.length) {
    const current = entries[i]!;
    const kind = current.frame.kind;
    if (kind === "chatMessageAppended") {
      const messageId = chatMessageId(current);
      if (messageId) {
        const segment = takeWhile(entries, i, (entry) =>
          entry.frame.kind === "chatMessageAppended" && chatMessageId(entry) === messageId
        );
        if (segment.length > 1) {
          out.push(mergeChatMessageAppended(segment, messageId));
          i += segment.length;
          continue;
        }
      }
    }
    if (kind === "documentSnapshotWritten") {
      const segment = takeWhile(entries, i, (entry) => entry.frame.kind === "documentSnapshotWritten");
      if (segment.length > 1) {
        out.push(mergeDocumentSnapshots(segment.slice(0, -1)));
        out.push(segment[segment.length - 1]!);
        i += segment.length;
        continue;
      }
    }
    if (kind === "docGenerationEvent") {
      const segment = takeWhile(entries, i, (entry) => entry.frame.kind === "docGenerationEvent");
      if (segment.length > 1) {
        out.push(mergeDocGenerationEvents(segment));
        i += segment.length;
        continue;
      }
    }
    out.push(current);
    i += 1;
  }
  return out;
}

function takeWhile(
  entries: FrameLogExportEntry[],
  start: number,
  predicate: (entry: FrameLogExportEntry) => boolean,
): FrameLogExportEntry[] {
  const segment: FrameLogExportEntry[] = [];
  for (let i = start; i < entries.length && predicate(entries[i]!); i += 1) {
    segment.push(entries[i]!);
  }
  return segment;
}

function mergeChatMessageAppended(segment: FrameLogExportEntry[], messageId: string): FrameLogExportEntry {
  const first = segment[0]!;
  const last = segment[segment.length - 1]!;
  const partKinds = new Set<string>();
  let chars = 0;
  for (const entry of segment) {
    const part = recordValue(recordValue(entry.frame)?.data)?.part;
    const kind = stringValue(recordValue(part)?.kind);
    if (kind) partKinds.add(kind);
    chars += partTextLength(part);
  }
  return {
    seq: first.seq,
    epoch: first.epoch,
    generation: first.generation,
    frame: {
      kind: "chatMessageAppended@merged",
      data: {
        messageId,
        frames: segment.length,
        seqFirst: first.seq,
        seqLast: last.seq,
        chars,
        partKinds: Array.from(partKinds),
      },
    },
  };
}

function mergeDocumentSnapshots(segment: FrameLogExportEntry[]): FrameLogExportEntry {
  const first = segment[0]!;
  const last = segment[segment.length - 1]!;
  return {
    seq: first.seq,
    epoch: first.epoch,
    generation: first.generation,
    frame: {
      kind: "documentSnapshotWritten@merged",
      data: {
        frames: segment.length,
        seqFirst: first.seq,
        seqLast: last.seq,
      },
    },
  };
}

function mergeDocGenerationEvents(segment: FrameLogExportEntry[]): FrameLogExportEntry {
  const first = segment[0]!;
  const last = segment[segment.length - 1]!;
  const kinds: Record<string, number> = {};
  for (const entry of segment) {
    const eventKind = stringValue(recordValue(recordValue(entry.frame)?.data)?.kind) ?? "unknown";
    kinds[eventKind] = (kinds[eventKind] ?? 0) + 1;
  }
  return {
    seq: first.seq,
    epoch: first.epoch,
    generation: first.generation,
    frame: {
      kind: "docGenerationEvent@merged",
      data: {
        frames: segment.length,
        seqFirst: first.seq,
        seqLast: last.seq,
        kinds,
      },
    },
  };
}

function chatMessageId(entry: FrameLogExportEntry): string | null {
  return stringValue(recordValue(recordValue(entry.frame)?.data)?.messageId);
}

function partTextLength(part: unknown): number {
  const data = recordValue(part)?.data;
  if (!data) return 0;
  return textLength(data);
}

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + textLength(item), 0);
  return Object.values(value as Record<string, unknown>).reduce<number>((sum, item) => sum + textLength(item), 0);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
