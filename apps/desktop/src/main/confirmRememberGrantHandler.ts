import type { IpcMainInvokeEvent } from "electron";
import {
  type NativeRememberGrantGate,
  rememberGrantKind,
  type RememberPromptCopy,
} from "./trustedRememberUi.js";

function boundedRememberId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : null;
}

export interface ConfirmRememberGrantContext {
  generation: number;
  scope: string;
  showPrompt: (copy: RememberPromptCopy) => Promise<"remember" | "cancel">;
}

export interface ConfirmRememberGrantHandlerDependencies {
  consumeTrustedRememberGesture: (event: IpcMainInvokeEvent) => boolean;
  getContext: () => ConfirmRememberGrantContext | null;
  gate: Pick<NativeRememberGrantGate, "request">;
  register: (input: {
    sessionId: string;
    confirmId: string;
    kind: NonNullable<ReturnType<typeof rememberGrantKind>>;
    scope: string;
  }) => Promise<string> | string;
  revoke: (nonce: string) => Promise<unknown> | unknown;
}

export function createConfirmRememberGrantHandler(
  dependencies: ConfirmRememberGrantHandlerDependencies,
): (event: IpcMainInvokeEvent, input: unknown) => Promise<string | null> {
  return async (event, input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    const sessionId = boundedRememberId(record.sessionId);
    const confirmId = boundedRememberId(record.confirmId);
    const kind = rememberGrantKind(record.kind);
    if (!sessionId || !confirmId || !kind || record.trustedGesture !== true) return null;
    if (!dependencies.consumeTrustedRememberGesture(event)) return null;
    const context = dependencies.getContext();
    if (!context) return null;
    return dependencies.gate.request({
      purpose: "confirm",
      kind,
      showPrompt: context.showPrompt,
      generation: context.generation,
      register: () => dependencies.register({
        sessionId,
        confirmId,
        kind,
        scope: context.scope,
      }),
      revoke: dependencies.revoke,
    });
  };
}
