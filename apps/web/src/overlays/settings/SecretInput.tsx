import { useState, type InputHTMLAttributes } from "react";

type SecretInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  "data-wf"?: string;
};

export function SecretInput({ className = "", "data-wf": dataWf, ...props }: SecretInputProps) {
  const [revealed, setRevealed] = useState(false);
  const inputClassName = `${className}${revealed ? "" : " sm-secret"}`.trim();

  return (
    <span className="sm-secret-wrap">
      <input
        {...props}
        type={revealed ? "text" : "password"}
        className={inputClassName}
        data-wf={dataWf}
      />
      <button
        type="button"
        className="sm-secret-toggle"
        aria-label={revealed ? "隐藏 API key" : "显示 API key"}
        aria-pressed={revealed}
        data-wf={dataWf ? `${dataWf}RevealToggle` : undefined}
        onClick={() => setRevealed((value) => !value)}
      >
        {revealed ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </span>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M2.6 10s2.7-4.5 7.4-4.5 7.4 4.5 7.4 4.5-2.7 4.5-7.4 4.5S2.6 10 2.6 10Z" />
      <circle cx="10" cy="10" r="2.1" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M3.2 3.4 16.8 16.6" />
      <path d="M7.6 5.9A7.7 7.7 0 0 1 10 5.5c4.7 0 7.4 4.5 7.4 4.5a10 10 0 0 1-2.1 2.5" />
      <path d="M12.1 13.8a7.7 7.7 0 0 1-2.1.7C5.3 14.5 2.6 10 2.6 10a10.1 10.1 0 0 1 2.3-2.7" />
      <path d="M8.8 8.8a2.1 2.1 0 0 0 2.4 2.4" />
    </svg>
  );
}
