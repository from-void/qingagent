import crypto from "node:crypto";
import type { BridgeFrame } from "@qingagent/contract-ts";
import type { PmDoc } from "@qingagent/pm-schema";
import { collectTopLevelTextBlocks, findLiteralMatches } from "../doc-engine/textEditOps.js";

export const MAX_ANNOTATION_PREVIEW_GROUPS = 64;
export const MAX_ANNOTATION_PREVIEW_ARGS_BYTES = 512 * 1_024;

type ScanPhase = "key" | "colon" | "array" | "groups" | "done";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * create_annotation_groups 参数增量扫描器。只在 groups 数组内的顶层对象闭合时解析；
 * 字符串（含反斜杠转义）里的括号完全不参与深度记账。
 */
export class IncrementalAnnotationGroupScanner {
  private buffer = "";
  private byteLength = 0;
  private index = 0;
  private phase: ScanPhase = "key";
  private inString = false;
  private escaped = false;
  private stringStart = -1;
  private objectStart = -1;
  private objectDepth = 0;
  private parsedCount = 0;
  private stopped = false;

  constructor(
    private readonly maxGroups = MAX_ANNOTATION_PREVIEW_GROUPS,
    private readonly maxBytes = MAX_ANNOTATION_PREVIEW_ARGS_BYTES,
  ) {}

  get isStopped(): boolean {
    return this.stopped;
  }

  feed(delta: string): Record<string, unknown>[] {
    if (this.stopped || !delta) return [];
    this.byteLength += Buffer.byteLength(delta, "utf8");
    if (this.byteLength > this.maxBytes) {
      this.stopped = true;
      return [];
    }
    this.buffer += delta;
    const parsed: Record<string, unknown>[] = [];

    while (this.index < this.buffer.length && !this.stopped) {
      const char = this.buffer[this.index]!;
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (char === "\\") {
          this.escaped = true;
        } else if (char === "\"") {
          this.inString = false;
          if (this.phase === "key") {
            const token = this.buffer.slice(this.stringStart, this.index + 1);
            try {
              if (JSON.parse(token) === "groups") this.phase = "colon";
            } catch {
              // 半截/非法字符串留给终局权威解析；预览静默跳过。
            }
          }
          this.stringStart = -1;
        }
        this.index += 1;
        continue;
      }

      if (char === "\"") {
        this.inString = true;
        this.stringStart = this.index;
        this.index += 1;
        continue;
      }

      if (this.phase === "colon") {
        if (/\s/u.test(char)) {
          this.index += 1;
          continue;
        }
        this.phase = char === ":" ? "array" : "key";
        this.index += 1;
        continue;
      }
      if (this.phase === "array") {
        if (/\s/u.test(char)) {
          this.index += 1;
          continue;
        }
        this.phase = char === "[" ? "groups" : "key";
        this.index += 1;
        continue;
      }
      if (this.phase !== "groups") {
        this.index += 1;
        continue;
      }

      if (char === "{" ) {
        if (this.objectDepth === 0) this.objectStart = this.index;
        this.objectDepth += 1;
      } else if (char === "}" && this.objectDepth > 0) {
        this.objectDepth -= 1;
        if (this.objectDepth === 0 && this.objectStart >= 0) {
          const slice = this.buffer.slice(this.objectStart, this.index + 1);
          this.objectStart = -1;
          try {
            const value = asRecord(JSON.parse(slice));
            if (value) {
              parsed.push(value);
              this.parsedCount += 1;
              if (this.parsedCount >= this.maxGroups) this.stopped = true;
            }
          } catch {
            // 单组增量解析失败不影响终局工具参数解析。
          }
        }
      } else if (char === "]" && this.objectDepth === 0) {
        this.phase = "done";
      }
      this.index += 1;
    }
    return parsed;
  }
}

export interface ScannedAnnotationGroup {
  previewId: string;
  source: Record<string, unknown>;
}

/** 同一 agent 回合管理多个 create_annotation_groups toolCallId 与全局 64 组上限。 */
export class AnnotationPreviewAccumulator {
  private readonly scanners = new Map<string, IncrementalAnnotationGroupScanner>();
  private sequence = 0;
  private emitted = 0;
  private limited = false;
  private started = false;

  get everStarted(): boolean {
    return this.started;
  }

  start(toolCallId: string): void {
    this.started = true;
    if (!this.scanners.has(toolCallId)) {
      this.scanners.set(toolCallId, new IncrementalAnnotationGroupScanner());
    }
  }

  feed(toolCallId: string, delta: string): ScannedAnnotationGroup[] {
    if (this.limited) return [];
    const scanner = this.scanners.get(toolCallId);
    if (!scanner) return [];
    const out: ScannedAnnotationGroup[] = [];
    for (const source of scanner.feed(delta)) {
      if (this.emitted >= MAX_ANNOTATION_PREVIEW_GROUPS) {
        this.limited = true;
        break;
      }
      this.sequence += 1;
      this.emitted += 1;
      out.push({ previewId: `annotation-preview-${toolCallId}-${this.sequence}`, source });
    }
    return out;
  }

  clear(): void {
    this.scanners.clear();
    // clear 只结束当前参数流的可见预览；64 组额度是“单 agent 回合”上限，
    // 同回合后续 create_annotation_groups 调用不能借 clear 重新获得额度。
  }
}

/** 单轮预览生命周期：保留全局组数额度，并统一生成幂等清理帧。 */
export class AnnotationPreviewState {
  readonly accumulator = new AnnotationPreviewAccumulator();
  private clearRequired = false;

  start(toolCallId: string): void {
    this.accumulator.start(toolCallId);
    this.clearRequired = true;
  }

  feed(toolCallId: string, delta: string): ScannedAnnotationGroup[] {
    return this.accumulator.feed(toolCallId, delta);
  }

  *clear(): Generator<BridgeFrame> {
    if (!this.clearRequired) return;
    this.accumulator.clear();
    this.clearRequired = false;
    yield { kind: "annotationPreviewCleared", data: {} };
  }
}

export function buildAnnotationPreviewData(
  doc: PmDoc,
  previewId: string,
  source: Record<string, unknown>,
): Extract<BridgeFrame, { kind: "annotationPreview" }>["data"] | null {
  const summary = typeof source.summary === "string" ? source.summary.trim() : "";
  if (!summary || !Array.isArray(source.anchors)) return null;
  const blocks = collectTopLevelTextBlocks(doc);
  const anchors = source.anchors.flatMap((candidate) => {
    const spec = asRecord(candidate);
    const find = typeof spec?.find === "string" ? spec.find : "";
    if (!find) return [];
    return findLiteralMatches(blocks, find, spec?.all === true).map((match) => ({
      blockId: match.blockId,
      pmFrom: match.pmFrom,
      pmTo: match.pmTo,
      quote: match.matchText,
      textHash: crypto.createHash("sha256").update(match.matchText).digest("hex").slice(0, 24),
    }));
  });
  return anchors.length > 0 ? { previewId, summary, anchors } : null;
}
