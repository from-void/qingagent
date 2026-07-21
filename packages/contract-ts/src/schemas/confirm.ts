import { z } from "zod";
import type {
  ConfirmDecision,
  ConfirmKind,
  ConfirmOption,
  ConfirmRequested,
  RememberCategory,
  ConfirmResolved,
  ConfirmSpec,
  ConfirmWidget,
  SubmitConfirmDecision,
} from "../Confirm";
import { boundedNonEmptyString } from "./common";
import type { Equal, Expect } from "./typeAssert";

const ID_MAX = 128;
const SECRET_MAX = 8_192;
const UI_GRANT_NONCE_MAX = 256;

export const confirmKindSchema = z.enum([
  "install",
  "connect",
  "send",
  "command",
]) satisfies z.ZodType<ConfirmKind>;
type _ConfirmKindExact = Expect<Equal<z.infer<typeof confirmKindSchema>, ConfirmKind>>;

export const confirmOptionSchema = z.object({
  value: boundedNonEmptyString(128),
  label: boundedNonEmptyString(120),
  description: boundedNonEmptyString(300).optional(),
  recommended: z.boolean().optional(),
}).strict() satisfies z.ZodType<ConfirmOption>;
type _ConfirmOptionExact = Expect<Equal<z.infer<typeof confirmOptionSchema>, ConfirmOption>>;

const confirmOptionsWidgetSchema = z.object({
  type: z.literal("options"),
  options: z.array(confirmOptionSchema).min(1).max(8),
}).strict().superRefine((widget, ctx) => {
  const values = new Set<string>();
  let recommendedCount = 0;
  widget.options.forEach((option, index) => {
    if (values.has(option.value)) {
      ctx.addIssue({
        code: "custom",
        path: ["options", index, "value"],
        message: "option value must be unique",
      });
    }
    values.add(option.value);
    if (option.recommended) recommendedCount += 1;
  });
  if (recommendedCount > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["options"],
      message: "at most one option may be recommended",
    });
  }
});

const confirmSecretWidgetSchema = z.object({
  type: z.literal("secretInput"),
  placeholder: boundedNonEmptyString(160),
}).strict();

export const confirmWidgetSchema = z.discriminatedUnion("type", [
  confirmOptionsWidgetSchema,
  confirmSecretWidgetSchema,
]) satisfies z.ZodType<ConfirmWidget>;
type _ConfirmWidgetExact = Expect<Equal<z.infer<typeof confirmWidgetSchema>, ConfirmWidget>>;

export const rememberCategorySchema = z.object({
  kind: z.enum(["install", "command"]),
  label: boundedNonEmptyString(160),
  riskHint: boundedNonEmptyString(300).optional(),
  insecureWithoutDesktop: z.boolean().optional(),
}).strict() satisfies z.ZodType<RememberCategory>;

export const confirmSpecSchema = z.object({
  id: boundedNonEmptyString(ID_MAX),
  kind: confirmKindSchema,
  title: boundedNonEmptyString(120),
  sub: boundedNonEmptyString(200).optional(),
  say: boundedNonEmptyString(1_200),
  commandPreview: boundedNonEmptyString(2_000).optional(),
  widget: confirmWidgetSchema.optional(),
  rememberCategory: rememberCategorySchema.optional(),
  footHint: boundedNonEmptyString(300),
  primaryLabel: boundedNonEmptyString(64),
  secondaryLabel: boundedNonEmptyString(64),
}).strict() satisfies z.ZodType<ConfirmSpec>;
type _ConfirmSpecExact = Expect<Equal<z.infer<typeof confirmSpecSchema>, ConfirmSpec>>;

export const confirmDecisionSchema = z.object({
  id: boundedNonEmptyString(ID_MAX),
  accepted: z.boolean(),
  optionValue: boundedNonEmptyString(128).optional(),
  secretValue: z.string().max(SECRET_MAX).optional(),
  remember: z.boolean().optional(),
  uiGrantNonce: boundedNonEmptyString(UI_GRANT_NONCE_MAX).optional(),
}).strict().superRefine((decision, ctx) => {
  if (!decision.accepted && decision.optionValue !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["optionValue"],
      message: "optionValue is forbidden when accepted is false",
    });
  }
  if (!decision.accepted && decision.secretValue !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["secretValue"],
      message: "secretValue is forbidden when accepted is false",
    });
  }
  if (!decision.accepted && decision.remember !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["remember"],
      message: "remember is forbidden when accepted is false",
    });
  }
  if (!decision.accepted && decision.uiGrantNonce !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["uiGrantNonce"],
      message: "uiGrantNonce is forbidden when accepted is false",
    });
  }
  if (decision.uiGrantNonce !== undefined && decision.remember !== true) {
    ctx.addIssue({
      code: "custom",
      path: ["uiGrantNonce"],
      message: "uiGrantNonce requires remember=true",
    });
  }
}) satisfies z.ZodType<ConfirmDecision>;
type _ConfirmDecisionExact = Expect<Equal<z.infer<typeof confirmDecisionSchema>, ConfirmDecision>>;

export const submitConfirmDecisionSchema = z.object({
  sessionId: boundedNonEmptyString(ID_MAX),
  toolCallId: boundedNonEmptyString(ID_MAX),
  decisionId: boundedNonEmptyString(ID_MAX),
  decision: confirmDecisionSchema,
}).strict() satisfies z.ZodType<SubmitConfirmDecision>;
type _SubmitConfirmDecisionExact = Expect<
  Equal<z.infer<typeof submitConfirmDecisionSchema>, SubmitConfirmDecision>
>;

export const confirmRequestedSchema = z.object({
  toolCallId: boundedNonEmptyString(ID_MAX),
  spec: confirmSpecSchema,
  requestedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict() satisfies z.ZodType<ConfirmRequested>;
type _ConfirmRequestedExact = Expect<
  Equal<z.infer<typeof confirmRequestedSchema>, ConfirmRequested>
>;

export const confirmResolvedSchema = z.object({
  id: boundedNonEmptyString(ID_MAX),
  toolCallId: boundedNonEmptyString(ID_MAX),
  resolution: z.enum(["accepted", "rejected", "expired", "aborted", "failed"]),
  message: boundedNonEmptyString(300).optional(),
}).strict() satisfies z.ZodType<ConfirmResolved>;
type _ConfirmResolvedExact = Expect<
  Equal<z.infer<typeof confirmResolvedSchema>, ConfirmResolved>
>;

/**
 * 决策与当前卡片的上下文校验。secretValue 只参与本次内存校验，调用方不得把
 * 返回错误与原值拼接或记录。
 */
export function confirmDecisionForSpecSchema(
  spec: ConfirmSpec,
): z.ZodType<ConfirmDecision> {
  return confirmDecisionSchema.superRefine((decision, ctx) => {
    if (decision.id !== spec.id) {
      ctx.addIssue({ code: "custom", path: ["id"], message: "id does not match confirm spec" });
      return;
    }
    if (!decision.accepted) return;

    if (decision.remember === true) {
      if (!spec.rememberCategory || spec.rememberCategory.kind !== spec.kind) {
        ctx.addIssue({
          code: "custom",
          path: ["remember"],
          message: "remember is forbidden for this confirm spec",
        });
      }
    }

    if (spec.widget?.type === "options") {
      if (
        decision.optionValue === undefined ||
        !spec.widget.options.some((option) => option.value === decision.optionValue)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["optionValue"],
          message: "optionValue must reference an option in the confirm spec",
        });
      }
      if (decision.secretValue !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["secretValue"],
          message: "secretValue is forbidden for an options confirm",
        });
      }
      return;
    }

    if (spec.widget?.type === "secretInput") {
      if (decision.secretValue === undefined || decision.secretValue.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["secretValue"],
          message: "secretValue must contain a non-whitespace value",
        });
      }
      if (decision.optionValue !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["optionValue"],
          message: "optionValue is forbidden for a secretInput confirm",
        });
      }
      return;
    }

    if (decision.optionValue !== undefined || decision.secretValue !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [decision.optionValue !== undefined ? "optionValue" : "secretValue"],
        message: "confirm without a widget cannot carry optionValue or secretValue",
      });
    }
  });
}
