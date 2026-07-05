import type { BridgeFrame, ChatChip, Command } from "@qingagent/contract-ts";
import { buildNativeDiffInstructions, planNativeTiming, type NativePresentationRun } from "./nativeDiffAnimation";
import type { StreamError } from "./protocol";
import type { WorkspaceAction } from "./workspaceState";
import { HISTORY_CHAT_INPUT_BLOCK_REASON } from "./chatInputBlockReason";
import { uploadAssetFile } from "./uploadAsset";
import type { ChatChipSpec, ChatInputHandle, ChatInputSnapshot } from "../components/ChatInput";
import type { UploadedAsset } from "./useMaterialParseTracker";

export function clientPerformanceNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

const PRESENTATION_RUN_WATCHDOG_BUFFER_MS = 4_000;
const PRESENTATION_RUN_WATCHDOG_MIN_MS = 5_000;
const PRESENTATION_RUN_WATCHDOG_MAX_MS = 65_000;

export function presentationRunWatchdogMs(run: NativePresentationRun): number {
  try {
    const timing = planNativeTiming(buildNativeDiffInstructions(run));
    return Math.min(
      PRESENTATION_RUN_WATCHDOG_MAX_MS,
      Math.max(
        PRESENTATION_RUN_WATCHDOG_MIN_MS,
        timing.totalDurationMs + PRESENTATION_RUN_WATCHDOG_BUFFER_MS,
      ),
    );
  } catch {
    return PRESENTATION_RUN_WATCHDOG_MIN_MS + PRESENTATION_RUN_WATCHDOG_BUFFER_MS;
  }
}

/** Map frontend ChatChipSpec to the contract ChatChip format. */
export function toContractChip(spec: ChatChipSpec): ChatChip {
  const CHIP_KIND_MAP: Record<ChatChipSpec["kind"], ChatChip["kind"]> = {
    sel: { kind: "selection" },
    attach: { kind: "attach" },
    mention: spec.skillId ? { kind: "skill" } : { kind: "mention" },
    longtext: { kind: "text" },
  };
  // Selection, attach, and mention chips require a resourceRef per
  // contract §5.1.3. Generate one with the appropriate domain so the
  // command passes validation (checkChip in command.ts).
  const REF_DOMAIN_MAP: Partial<
    Record<ChatChipSpec["kind"], ChatChip["resourceRef"]>
  > = {
    // 选区/块引用:resourceRef.id 直接承载稳定 blockId(后端按 id 精确找回引用的块);
    // 缺 blockId(老链路/异常)才退回时间戳占位 id,后端找不到该 id 时自然降级到位置/文本。
    sel: { id: spec.blockId ?? spec.selectionRefs?.[0] ?? `sel-${Date.now()}`, domain: { kind: "docSpan" } },
    attach: { id: `att-${Date.now()}`, domain: { kind: "file" } },
    mention: { id: `men-${Date.now()}`, domain: { kind: "mention" } },
  };
  const chip: ChatChip = {
    kind: CHIP_KIND_MAP[spec.kind] ?? { kind: "text" },
    resourceRef: spec.skillId ? null : REF_DOMAIN_MAP[spec.kind] ?? null,
    ...(spec.skillId ? { skillId: spec.skillId } : {}),
    prefix: spec.prefix ?? null,
    label: spec.label,
    suffix: spec.suffix ?? null,
  };
  // Pass through from/to for selection chips
  if (spec.from !== undefined) chip.from = spec.from;
  if (spec.to !== undefined) chip.to = spec.to;
  if (spec.selectionRefs && spec.selectionRefs.length > 0) chip.selectionRefs = spec.selectionRefs;
  // 长文本卡片携带完整原文,供气泡里展开还原(后端不消费;原文已展开进 SendMessage.text)。
  if (spec.text !== undefined) chip.text = spec.text;
  return chip;
}

export async function uploadFiles(files: File[]): Promise<UploadedAsset[]> {
  if (files.length === 0) return [];

  const uploadedAssets: UploadedAsset[] = [];
  for (const file of files) {
    const data = await uploadAssetFile(file);
    uploadedAssets.push({
      fileId: data.fileId,
      filename: file.name,
      mime: file.type || null,
      size: file.size,
    });
  }
  return uploadedAssets;
}

export function sendFailureToastMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error || "");
  return detail ? "发送失败，请重试" : "发送失败，请重试";
}

const RESTORE_EXISTING_RETRY_DELAYS_MS = [500, 1000, 2000] as const;

type StartSessionPromiseRef = { current: Promise<string> | null };
type StartSessionPromisesBySessionRef = { current: Map<string, Promise<string>> };

export function isRetriableSessionRestoreError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const status = message.match(/Stream request failed:\s*(\d{3})/i)?.[1];
  if (status) return Number(status) >= 500;
  return /failed to fetch|network|load failed|fetch/i.test(message);
}

export async function restoreExistingSessionWithRetry(input: {
  sessionId: string;
  startSession: (data: Extract<Command, { kind: "startSession" }>["data"]) => Promise<string>;
  startSessionPromiseRef?: StartSessionPromiseRef;
  startSessionPromisesBySessionRef?: StartSessionPromisesBySessionRef;
  dispatch: (action: WorkspaceAction) => void;
  delay?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
  failureError?: StreamError;
}): Promise<string> {
  const keyedPromises = input.startSessionPromisesBySessionRef?.current;
  const existingPromise =
    keyedPromises?.get(input.sessionId) ?? input.startSessionPromiseRef?.current;
  if (existingPromise) return existingPromise;

  const retryDelays = input.retryDelaysMs ?? RESTORE_EXISTING_RETRY_DELAYS_MS;
  const delay = input.delay ?? ((ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)));
  const promise = (async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await input.startSession({
          mode: { kind: "existing", data: { id: input.sessionId } },
        });
      } catch (error) {
        const retryDelay = retryDelays[attempt];
        if (retryDelay == null || !isRetriableSessionRestoreError(error)) {
          input.dispatch({
            kind: "streamErrorSet",
            error: input.failureError ?? {
              kind: "failed",
              reason: "恢复会话失败，请重试",
              retriable: true,
            },
          });
          throw error;
        }
        await delay(retryDelay);
      }
    }
  })();

  if (keyedPromises) keyedPromises.set(input.sessionId, promise);
  else if (input.startSessionPromiseRef) input.startSessionPromiseRef.current = promise;
  try {
    return await promise;
  } finally {
    if (keyedPromises?.get(input.sessionId) === promise) {
      keyedPromises.delete(input.sessionId);
    } else if (input.startSessionPromiseRef?.current === promise) {
      input.startSessionPromiseRef.current = null;
    }
  }
}

export function bridgeFrameSessionId(frame: BridgeFrame): string | null {
  switch (frame.kind) {
    case "sessionMeta":
      return frame.data.sessionId;
    case "docCommitted":
      return frame.data.sessionId;
    case "folderSourcesChanged":
      return frame.data.sessionId;
    case "docGenerationEvent":
      return frame.data.kind === "generation_started" ? frame.data.data.sessionId : null;
    default:
      return null;
  }
}

export function shouldAcceptBridgeFrameForSession(input: {
  frame: BridgeFrame;
  activeSessionId: string | null;
  streamSessionId: string | null;
}): boolean {
  const { activeSessionId, streamSessionId } = input;
  const frameSessionId = bridgeFrameSessionId(input.frame);
  if (activeSessionId && frameSessionId && frameSessionId !== activeSessionId) {
    return false;
  }
  if (activeSessionId && streamSessionId && streamSessionId !== activeSessionId) {
    return false;
  }
  return true;
}

export function rollbackOptimisticChatSend(input: {
  dispatch: (action: WorkspaceAction) => void;
  chatInput: Pick<ChatInputHandle, "restore"> | null | undefined;
  snapshot: ChatInputSnapshot;
  keepMessageCount: number;
  setSendPending: (value: boolean) => void;
  showToast: (message: string) => void;
  error: unknown;
}): void {
  input.setSendPending(false);
  input.dispatch({ kind: "rewindChat", keepMessageCount: input.keepMessageCount });
  input.chatInput?.restore(input.snapshot);
  input.showToast(sendFailureToastMessage(input.error));
}

export function submitImmediateChatInputSend(input: {
  chatInput: Pick<ChatInputHandle, "clear" | "insertText"> | null | undefined;
  text: string;
  viewingHistory: boolean;
  submit: () => void;
  showToast: (message: string, durationMs?: number) => void;
  schedule?: (callback: () => void) => void;
}): void {
  if (input.viewingHistory) {
    input.showToast(
      HISTORY_CHAT_INPUT_BLOCK_REASON.toast,
      HISTORY_CHAT_INPUT_BLOCK_REASON.durationMs,
    );
    return;
  }
  const schedule = input.schedule ?? ((callback: () => void) => window.setTimeout(callback, 0));
  schedule(() => {
    input.chatInput?.clear();
    input.chatInput?.insertText(input.text);
    schedule(input.submit);
  });
}
