import type { CSSProperties, ReactNode } from "react";

/**
 * Wrapper around a consumer-supplied `<textarea>` or `<input>`. The wrapper
 * carries the wireframe's `wf-input` chrome (focus ring, border, padding);
 * callers wire `value`/`onChange` on the inner element themselves.
 */
export interface InputProps {
  style?: CSSProperties;
  children?: ReactNode;
}

export function Input({ style, children }: InputProps) {
  return (
    <div data-wf="Input" className="wf-input" style={style}>
      {children}
    </div>
  );
}
