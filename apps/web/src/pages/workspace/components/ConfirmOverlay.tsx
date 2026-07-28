import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ConfirmDecision, ConfirmSpec } from "@qingagent/contract-ts";
import { magicMoveFromRect, magicMoveToRect } from "../data/barMorph";
import { CheckIcon } from "./icons";
import { useToast } from "../../../system";
import "./confirm-overlay.css";

export type { ConfirmDecision, ConfirmSpec } from "@qingagent/contract-ts";

interface InputBoxRef {
  readonly current: HTMLElement | null;
}

export interface ConfirmOverlayProps {
  sessionId: string | null;
  spec: ConfirmSpec;
  inputBoxRef?: InputBoxRef;
  onDecision: (
    decision: ConfirmDecision,
    context?: { componentMounted: false },
  ) => void;
  submissionError?: string | null;
  /** live 卡由 confirmResolved SSE 收口；不能等待阻塞式 decision POST 才关闭。 */
  waitForResolution?: boolean;
}

export interface ConfirmRecord {
  label: string;
  segment: string;
  meta: string;
}

function initialOptionValue(spec: ConfirmSpec): string | undefined {
  if (spec.widget?.type !== "options") return undefined;
  return (
    spec.widget.options.find((option) => option.recommended)?.value ??
    spec.widget.options[0]?.value
  );
}

function findInputBox(inputBoxRef: InputBoxRef | undefined): HTMLElement | null {
  const root = inputBoxRef?.current;
  return root?.querySelector<HTMLElement>(".wf-input") ?? root ?? null;
}

export function ConfirmOverlay({
  sessionId,
  spec,
  inputBoxRef,
  onDecision,
  submissionError = null,
  waitForResolution = false,
}: ConfirmOverlayProps) {
  const toast = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  const secretInputRef = useRef<HTMLInputElement>(null);
  const closingRef = useRef(false);
  const mountedRef = useRef(true);
  const titleId = useId();
  const sayId = useId();
  const rememberRiskId = useId();
  const [selectedOption, setSelectedOption] = useState(() =>
    initialOptionValue(spec),
  );
  const [secretReady, setSecretReady] = useState(
    spec.widget?.type !== "secretInput",
  );
  const [pendingState, setPendingState] = useState<
    { phase: "confirming" | "submitting"; accepted: boolean } | null
  >(null);
  const [remember, setRemember] = useState(false);
  const rememberCapability = window.electron?.requestConfirmRememberGrant;
  const showRemember = Boolean(
    sessionId && spec.rememberCategory
      && (rememberCapability || spec.rememberCategory.insecureWithoutDesktop),
  );
  const busy = pendingState !== null;
  const statusText = pendingState?.phase === "confirming"
    ? "正在确认…"
    : pendingState?.accepted === false
      ? "正在取消…"
      : "正在执行…";
  useEffect(() => {
    mountedRef.current = true;
    const previousActiveElement =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const panel = panelRef.current;
    const primaryButton = panel?.querySelector<HTMLElement>(
      ".cf-primary:not([disabled])",
    );
    (primaryButton ?? panel)?.focus({ preventScroll: true });

    return () => {
      mountedRef.current = false;
      if (previousActiveElement?.isConnected) {
        previousActiveElement.focus({ preventScroll: true });
      }
    };
  }, []);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const inputBox = findInputBox(inputBoxRef);
    if (!panel) return;
    magicMoveFromRect(panel, inputBox?.getBoundingClientRect() ?? null);
  }, [inputBoxRef]);

  useEffect(() => {
    if (!submissionError) return;
    closingRef.current = false;
    setPendingState(null);
  }, [submissionError]);

  const decide = async (accepted: boolean, trustedGesture = false) => {
    if (closingRef.current) return;
    closingRef.current = true;
    const needsNativeRememberConfirm = Boolean(
      accepted && remember && showRemember && spec.rememberCategory
        && rememberCapability && sessionId,
    );
    setPendingState({
      phase: needsNativeRememberConfirm ? "confirming" : "submitting",
      accepted,
    });

    const decision: ConfirmDecision = { id: spec.id, accepted };
    if (accepted && spec.widget?.type === "options" && selectedOption) {
      decision.optionValue = selectedOption;
    }
    if (accepted && spec.widget?.type === "secretInput") {
      decision.secretValue = secretInputRef.current?.value ?? "";
    }
    if (accepted && remember && showRemember && spec.rememberCategory) {
      if (rememberCapability && sessionId) {
        try {
          const nonce = await rememberCapability({
            sessionId,
            confirmId: spec.id,
            kind: spec.rememberCategory.kind,
            trustedGesture,
          });
          if (nonce) {
            decision.remember = true;
            decision.uiGrantNonce = nonce;
          } else if (mountedRef.current) {
            setRemember(false);
            toast.show({
              message: "本次操作会继续，但没有记住这次选择；下次同类操作仍会询问。",
              tone: "warn",
              dedupeKey: `confirm-remember-not-saved:${spec.id}`,
            });
          }
        } catch {
          if (mountedRef.current) {
            setRemember(false);
            toast.show({
              message: "本次操作会继续，但没有记住这次选择；下次同类操作仍会询问。",
              tone: "warn",
              dedupeKey: `confirm-remember-not-saved:${spec.id}`,
            });
          }
          // 原生确认未完成只放弃记忆；本次同意仍由服务端照常处理。
        }
      } else if (spec.rememberCategory.insecureWithoutDesktop) {
        decision.remember = true;
      }
    }

    if (mountedRef.current) {
      setPendingState({ phase: "submitting", accepted });
    }

    const finish = () => {
      if (mountedRef.current) onDecision(decision);
      else onDecision(decision, { componentMounted: false });
    };
    if (waitForResolution) {
      finish();
      return;
    }
    const panel = panelRef.current;
    const inputBox = findInputBox(inputBoxRef);
    if (!panel) {
      finish();
      return;
    }
    magicMoveToRect(panel, inputBox?.getBoundingClientRect() ?? null, {
      onArrive: finish,
    });
  };

  return (
    <div
      ref={panelRef}
      className="cf-overlay"
      data-wf="ConfirmOverlay"
      data-kind={spec.kind}
      data-busy={busy ? "true" : "false"}
      role="dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={sayId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          void decide(false);
        }
      }}
    >
      <div className="cf-head">
        <div className="cf-heading" id={titleId}>
          <span className="cf-dot" aria-hidden="true" />
          <span className="cf-title">{spec.title}</span>
          {spec.sub && <span className="cf-sub">{spec.sub}</span>}
        </div>
        <button
          type="button"
          className="cf-close"
          aria-label="关闭"
          disabled={busy}
          onClick={() => void decide(false)}
        >
          ×
        </button>
      </div>

      <div className="cf-body">
        {busy ? (
          <p className="cf-progress" role="status" aria-live="polite">
            <span className="cf-spinner" aria-hidden="true" />
            {statusText}
          </p>
        ) : submissionError ? (
          <p className="cf-progress is-error" role="alert">
            {submissionError}
          </p>
        ) : null}
        <p className="cf-say" id={sayId}>
          {spec.say}
        </p>

        {spec.notice && (
          <p className="cf-notice" role="status">{spec.notice}</p>
        )}

        {spec.commandPreview && (
          <pre className="cf-command-preview" aria-label="命令预览">
            {spec.commandPreview}
          </pre>
        )}

        {spec.widget?.type === "options" && (
          <div className="cf-options" role="radiogroup" aria-label={spec.title}>
            {spec.widget.options.map((option) => {
              const checked = selectedOption === option.value;
              return (
                <label
                  className="cf-option"
                  data-checked={checked ? "true" : "false"}
                  key={option.value}
                >
                  <input
                    type="radio"
                    name={`confirm-option-${spec.id}`}
                    value={option.value}
                    checked={checked}
                    disabled={busy}
                    onChange={() => setSelectedOption(option.value)}
                  />
                  <span className="cf-option-title">{option.label}</span>
                  {option.recommended && (
                    <span className="cf-recommended">推荐</span>
                  )}
                  {option.description && (
                    <span className="cf-option-description">
                      {option.description}
                    </span>
                  )}
                  <span className="cf-option-check" aria-hidden="true">
                    {checked && <CheckIcon size={11} />}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        {spec.widget?.type === "secretInput" && (
          <input
            ref={secretInputRef}
            className="cf-secret"
            type="password"
            autoComplete="off"
            placeholder={spec.widget.placeholder}
            aria-label={spec.widget.placeholder}
            disabled={busy}
            onInput={(event) =>
              setSecretReady(event.currentTarget.value.trim().length > 0)
            }
          />
        )}

      </div>

      <div className="cf-foot">
        {(spec.footHint ||
          (!showRemember && sessionId && spec.rememberCategory)) && (
          <div className="cf-foot-copy">
            {!showRemember && sessionId && spec.rememberCategory && (
              <p className="cf-remember-unavailable">
                开启记忆需要在桌面应用中完成确认。
              </p>
            )}
            {spec.footHint && <span className="cf-foot-hint">{spec.footHint}</span>}
          </div>
        )}
        <div className="cf-actions">
          {showRemember && spec.rememberCategory && (
            <label className="cf-remember">
              <input
                type="checkbox"
                checked={remember}
                disabled={busy}
                aria-describedby={spec.rememberCategory.riskHint ? rememberRiskId : undefined}
                onChange={(event) => setRemember(event.currentTarget.checked)}
              />
              <span className="cf-remember-box" aria-hidden="true">
                {remember && <CheckIcon size={11} />}
              </span>
              <span className="cf-remember-copy">
                <span>{spec.rememberCategory.label}</span>
                {spec.rememberCategory.riskHint && (
                  <span
                    className="cf-remember-risk"
                    id={rememberRiskId}
                  >
                    {spec.rememberCategory.riskHint}
                  </span>
                )}
              </span>
            </label>
          )}
          <button
            type="button"
            className="cf-button cf-secondary"
            disabled={busy}
            onClick={() => void decide(false)}
          >
            {spec.secondaryLabel}
          </button>
          <button
            type="button"
            className="cf-button cf-primary"
            disabled={busy || !secretReady}
            aria-busy={busy}
            onClick={(event) => void decide(true, event.isTrusted)}
          >
            {busy && <span className="cf-button-spinner" aria-hidden="true" />}
            {busy ? statusText : spec.primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConfirmRecordBar({ record }: { record: ConfirmRecord }) {
  return (
    <div className="cf-record u-scope" data-wf="ConfirmRecordBar" role="status">
      <div className="u-bar">
        <span className="u-ico cf-record-check" aria-hidden="true">
          <CheckIcon size={12} />
        </span>
        <span className="u-lbl">{record.label}</span>
        <span className="u-seg">{record.segment}</span>
        <span className="u-spacer" />
        <span className="u-meta">{record.meta}</span>
      </div>
    </div>
  );
}
