import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { magicMoveFromRect, magicMoveToRect } from "../data/barMorph";
import { CheckIcon } from "./icons";
import "./confirm-overlay.css";

export interface ConfirmSpec {
  id: string;
  kind: "install" | "connect" | "send";
  title: string;
  sub?: string;
  say: string;
  widget?:
    | {
        type: "options";
        options: {
          value: string;
          label: string;
          description?: string;
          recommended?: boolean;
        }[];
      }
    | { type: "secretInput"; placeholder: string };
  footHint: string;
  primaryLabel: string;
  secondaryLabel: string;
}

export interface ConfirmDecision {
  id: string;
  accepted: boolean;
  optionValue?: string;
  secretValue?: string;
}

interface InputBoxRef {
  readonly current: HTMLElement | null;
}

export interface ConfirmOverlayProps {
  spec: ConfirmSpec;
  inputBoxRef?: InputBoxRef;
  onDecision: (decision: ConfirmDecision) => void;
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
  spec,
  inputBoxRef,
  onDecision,
}: ConfirmOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const secretInputRef = useRef<HTMLInputElement>(null);
  const closingRef = useRef(false);
  const mountedRef = useRef(true);
  const titleId = useId();
  const sayId = useId();
  const [selectedOption, setSelectedOption] = useState(() =>
    initialOptionValue(spec),
  );
  const [secretReady, setSecretReady] = useState(
    spec.widget?.type !== "secretInput",
  );
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    const previousActiveElement =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    panelRef.current
      ?.querySelector<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex=\"-1\"])",
      )
      ?.focus({ preventScroll: true });

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

  const decide = (accepted: boolean) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);

    const decision: ConfirmDecision = { id: spec.id, accepted };
    if (accepted && spec.widget?.type === "options" && selectedOption) {
      decision.optionValue = selectedOption;
    }
    if (accepted && spec.widget?.type === "secretInput") {
      decision.secretValue = secretInputRef.current?.value ?? "";
    }

    const finish = () => {
      if (mountedRef.current) onDecision(decision);
    };
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
      data-closing={closing ? "true" : "false"}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={sayId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          decide(false);
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
          onClick={() => decide(false)}
        >
          ×
        </button>
      </div>

      <div className="cf-body">
        <p className="cf-say" id={sayId}>
          {spec.say}
        </p>

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
            onInput={(event) =>
              setSecretReady(event.currentTarget.value.trim().length > 0)
            }
          />
        )}
      </div>

      <div className="cf-foot">
        <span className="cf-foot-hint">{spec.footHint}</span>
        <div className="cf-actions">
          <button
            type="button"
            className="cf-button cf-secondary"
            onClick={() => decide(false)}
          >
            {spec.secondaryLabel}
          </button>
          <button
            type="button"
            className="cf-button cf-primary"
            disabled={!secretReady}
            onClick={() => decide(true)}
          >
            {spec.primaryLabel}
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
          ✓
        </span>
        <span className="u-lbl">{record.label}</span>
        <span className="u-seg">{record.segment}</span>
        <span className="u-spacer" />
        <span className="u-meta">{record.meta}</span>
      </div>
    </div>
  );
}
