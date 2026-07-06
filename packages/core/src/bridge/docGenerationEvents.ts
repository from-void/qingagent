import type { DocGenerationEvent } from "@qingagent/contract-ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asDocGenerationEvent(value: unknown): DocGenerationEvent | null {
  const record = asRecord(value);
  if (!record || typeof record.kind !== "string") return null;
  const data = asRecord(record.data);
  if (!data || typeof data.generationId !== "string") return null;
  if (!Number.isInteger(data.seq)) return null;
  const prevSeq = data.prevSeq;
  if (prevSeq !== null && !Number.isInteger(prevSeq)) return null;
  return record as unknown as DocGenerationEvent;
}

export function nextDocGenerationEvent(
  generationId: string,
  lastSeq: number,
  event:
    | { kind: "generation_finished"; data: Omit<Extract<DocGenerationEvent, { kind: "generation_finished" }>["data"], "generationId" | "seq" | "prevSeq"> }
    | { kind: "generation_failed"; data: Omit<Extract<DocGenerationEvent, { kind: "generation_failed" }>["data"], "generationId" | "seq" | "prevSeq"> },
): DocGenerationEvent {
  const seq = lastSeq + 1;
  const prevSeq = lastSeq === 0 ? null : lastSeq;
  return {
    kind: event.kind,
    data: {
      generationId,
      seq,
      prevSeq,
      ...event.data,
    },
  } as DocGenerationEvent;
}
