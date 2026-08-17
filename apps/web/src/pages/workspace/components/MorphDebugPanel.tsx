import { useState } from "react";
import { morphTuning } from "../data/barMorph";
import { CloseIcon, DiagonalArrowIcon } from "./icons";

// 临时调试面板(Ctrl+Shift+H 唤起):实时调「输入框→操作条」平移形变的时长/缓动,
// 选条类型(问卷确认条 / 审批条),分别重播进场 / 返回。调好把数值告诉作者固化即可。

export type DemoBarKind = "bigplan" | "patch";

const EASINGS: { label: string; value: string }[] = [
  { label: "回弹", value: "cubic-bezier(.34,1.28,.5,1)" },
  { label: "强回弹", value: "cubic-bezier(.34,1.56,.64,1)" },
  { label: "顺滑", value: "cubic-bezier(.22,.7,.3,1)" },
  { label: "急停", value: "cubic-bezier(.16,1,.3,1)" },
  { label: "线性", value: "linear" },
];

interface Props {
  kind: DemoBarKind;
  shown: boolean;
  onKind: (k: DemoBarKind) => void;
  onEnter: () => void; // 进场:条从输入框滑入(已在场则重播)
  onReturn: () => void; // 返回:条滑回输入框
  onClose: () => void;
}

export function MorphDebugPanel({ kind, shown, onKind, onEnter, onReturn, onClose }: Props) {
  const [dur, setDur] = useState(morphTuning.durationMs);
  const [easing, setEasing] = useState(morphTuning.easing);

  return (
    <div className="morph-debug-panel" data-wf="MorphDebugPanel">
      <div className="mdp-head">
        <span>输入框 → 操作条 · 形变调试</span>
        <button className="mdp-x" onClick={onClose} title="关闭(Ctrl+Shift+H)">
          <CloseIcon size={15} />
        </button>
      </div>

      <label className="mdp-row">
        <span className="mdp-k">时长</span>
        <input
          type="range"
          min={150}
          max={1400}
          step={10}
          value={dur}
          onChange={(e) => {
            const d = Number(e.target.value);
            setDur(d);
            morphTuning.durationMs = d;
          }}
        />
        <span className="mdp-v">{dur}ms</span>
      </label>

      <div className="mdp-easings">
        {EASINGS.map((opt) => (
          <button
            key={opt.value}
            className={easing === opt.value ? "is-on" : ""}
            onClick={() => {
              setEasing(opt.value);
              morphTuning.easing = opt.value;
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="mdp-current">{easing}</div>

      <div className="mdp-group-label">条类型</div>
      <div className="mdp-kinds">
        <button
          className={kind === "bigplan" ? "is-on" : ""}
          onClick={() => onKind("bigplan")}
        >
          问卷条
        </button>
        <button
          className={kind === "patch" ? "is-on" : ""}
          onClick={() => onKind("patch")}
        >
          审批条
        </button>
      </div>

      <div className="mdp-actions">
        <button className="mdp-enter" onClick={onEnter}>
          进场 <DiagonalArrowIcon direction="down-right" />
        </button>
        <button className="mdp-return" onClick={onReturn} disabled={!shown}>
          返回 <DiagonalArrowIcon direction="down-left" />
        </button>
      </div>
    </div>
  );
}
