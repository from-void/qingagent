// AskUserSpec runtime validator — relaxed limits for LLM-generated specs.

import type { AskUserSpec } from "@qingagent/contract-ts";

export class AskUserSpecValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskUserSpecValidationError";
  }
}

export function validateAskUserSpec(spec: AskUserSpec): void {
  if (spec.questions.length > 8) {
    throw new AskUserSpecValidationError(
      `askUser allows at most 8 questions, got ${spec.questions.length}`,
    );
  }
  for (const q of spec.questions) {
    const optLen = q.options?.length ?? 0;
    if (optLen > 8) {
      throw new AskUserSpecValidationError(
        `askUser allows at most 8 options per question, got ${optLen}`,
      );
    }
    if (q.kind.kind === "text" && optLen > 0) {
      throw new AskUserSpecValidationError(
        `askUser kind=Text must have empty options`,
      );
    }
    // F4:slider 必须带合法 slider 配置(min<max,step>0),options 必须为空。
    if (q.kind.kind === "slider") {
      const s = q.slider;
      if (!s || !(s.min < s.max) || !(s.step > 0)) {
        throw new AskUserSpecValidationError(
          `askUser kind=Slider requires valid slider config (min<max, step>0)`,
        );
      }
      if (optLen > 0) {
        throw new AskUserSpecValidationError(
          `askUser kind=Slider must have empty options`,
        );
      }
    }
  }
}
