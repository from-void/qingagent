import { z } from "zod";
import type { Command } from "../Command";
import type { LegacySection } from "../LegacySection";
import type { PmDoc } from "../PmDoc";
import type { SessionMode } from "../SessionMode";
import type { StartSession } from "../StartSession";
import type { SendMessage } from "../SendMessage";
import type { ActionCardData } from "../ActionCard";
import type { CancelStream } from "../CancelStream";
import type { AcceptPatch } from "../AcceptPatch";
import type { RejectPatch } from "../RejectPatch";
import type { CommitPatches } from "../CommitPatches";
import type { CommitReviewGroups } from "../CommitReviewGroups";
import type { SubmitReviewOutcome } from "../SubmitReviewOutcome";
import type { ResumeAskUser } from "../ResumeAskUser";
import type { AskUserAnswer } from "../AskUserAnswer";
import type { CancelAskUser } from "../CancelAskUser";
import type { UpdateDoc } from "../UpdateDoc";
import type { UpdateMaterialSummary } from "../UpdateMaterialSummary";
import type { RemoveMaterial } from "../RemoveMaterial";
import type { ReparseMaterial } from "../ReparseMaterial";
import type { AttachFolder, DetachFolder } from "../FolderSource";
import type { ExternalPropose, ExternalProposeOp } from "../ExternalPropose";
import type { IgnoreAnnotationGroups } from "../IgnoreAnnotationGroups";
import {
  boundedNonEmptyString,
  chatChipSchema,
  MAX_COMMAND_ARRAY_LENGTH,
  MAX_COMMAND_STRING_LENGTH,
  resourceRefSchema,
  skillRefSchema,
  uploadIdSchema,
} from "./common";
import type { Equal, Expect } from "./typeAssert";

// 与旧手写校验对齐的长度上限(stream.ts MAX_FOLDER_COMMAND_*_LENGTH)。
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
const MAX_HANDLE_LENGTH = 1024;

/**
 * updateDoc 的 doc / legacySections 为**运行期直通**(z.unknown()),类型层声明为
 * PmDoc / LegacySection[]。这是设计决策 1 的刻意取舍:contract-ts 不引入对 pm-schema
 * 的生产依赖(避免 contract-ts → pm-schema 依赖环),legacySections 在此只加顶层数组
 * 长度护栏；PM 文档与 section 元素的深层结构仍由 server 侧现有
 * `safeParsePmDoc` / `validateLegacySections` 承担。
 * 因此这里用受控 cast 把"运行期 unknown、类型层精确"两者兜住,既不拉依赖、又保住
 * `commandSchema satisfies z.ZodType<Command>` 与等价断言。
 */
function addArrayLengthIssue(context: z.RefinementCtx): void {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: `must contain at most ${MAX_COMMAND_ARRAY_LENGTH} items`,
  });
}

const pmDocPassthroughSchema = z.unknown().superRefine((value, context) => {
  if (
    value !== null
    && typeof value === "object"
    && Array.isArray((value as Record<string, unknown>).content)
    && (value as { content: unknown[] }).content.length > MAX_COMMAND_ARRAY_LENGTH
  ) {
    addArrayLengthIssue(context);
  }
}) as unknown as z.ZodType<PmDoc>;
const legacySectionsPassthroughSchema = z.unknown().superRefine((value, context) => {
  if (Array.isArray(value) && value.length > MAX_COMMAND_ARRAY_LENGTH) {
    addArrayLengthIssue(context);
  }
}) as unknown as z.ZodType<Array<LegacySection>>;
const ignoreAnnotationGroupsDataSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.enum(["tab_changed", "message_sent", "doc_committed", "discard_all", "item_ignored"]),
  groupIds: z
    .array(boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH))
    .min(1)
    .max(MAX_COMMAND_ARRAY_LENGTH)
    .optional(),
  rememberDismissal: z.boolean().optional(),
}).superRefine((data, context) => {
  if (data.rememberDismissal && !data.groupIds?.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["groupIds"],
      message: "下次不再提示必须指定批注组",
    });
  }
}) satisfies z.ZodType<IgnoreAnnotationGroups>;

// ---- 各 command 载荷 schema(逐一锚定到手写契约类型)----

const sessionModeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("existing"),
    data: z.object({ id: boundedNonEmptyString(MAX_ID_LENGTH) }),
  }),
  z.object({
    kind: z.literal("new"),
    data: z.object({
      template: z.string().nullable(),
      sessionId: boundedNonEmptyString(MAX_ID_LENGTH).optional(),
    }),
  }),
]) satisfies z.ZodType<SessionMode>;
type _SessionModeExact = Expect<Equal<z.infer<typeof sessionModeSchema>, SessionMode>>;

const startSessionDataSchema = z.object({
  mode: sessionModeSchema,
}) satisfies z.ZodType<StartSession>;
type _StartSessionExact = Expect<Equal<z.infer<typeof startSessionDataSchema>, StartSession>>;

const actionCardDataSchema = z.object({
  icon: z.string().max(MAX_COMMAND_STRING_LENGTH).optional(),
  title: z.string().max(MAX_COMMAND_STRING_LENGTH),
  lines: z.array(z.object({
    label: z.string().max(MAX_COMMAND_STRING_LENGTH),
    value: z.string().max(MAX_COMMAND_STRING_LENGTH),
  })).max(MAX_COMMAND_ARRAY_LENGTH),
}) satisfies z.ZodType<ActionCardData>;

const reviewTypeSchema = z.enum([
  "sensitive", "deai", "source", "consistency", "privacy", "format", "role", "custom",
]);

const reviewContextSchema = z.object({
  type: reviewTypeSchema,
  templateId: boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH),
  templateName: boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH),
});

const sendMessageDataSchema = z.object({
  sessionId: boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH),
  text: z.string().max(MAX_COMMAND_STRING_LENGTH),
  mentions: z
    .array(resourceRefSchema)
    .max(0, "mentions is deprecated; use chips instead")
    .default([]),
  skills: z.array(skillRefSchema).max(MAX_COMMAND_ARRAY_LENGTH),
  chips: z.array(chatChipSchema).max(MAX_COMMAND_ARRAY_LENGTH),
  // fileIds 缺省即 []:契约类型要求 fileIds 存在,但旧手写校验容忍其缺省(视作无文件)。
  // .default([]) 让"输入可省=与旧行为等价、输出恒为 string[]=与契约类型精确等价"两者兼得;
  // 下游 bridgeHandler 亦以 `fileIds ?? []` 消费,[] 与 undefined 行为一致。
  fileIds: z.array(uploadIdSchema).max(MAX_COMMAND_ARRAY_LENGTH).default([]),
  clientMessageId: z.string().max(MAX_COMMAND_STRING_LENGTH).optional(),
  richText: z.string().max(MAX_COMMAND_STRING_LENGTH).optional(),
  turnContext: z.string().max(MAX_COMMAND_STRING_LENGTH).optional(),
  turnKind: z.literal("generateDerivative").optional(),
  displayCard: actionCardDataSchema.optional(),
  reviewContext: reviewContextSchema.optional(),
}) satisfies z.ZodType<SendMessage>;
type _SendMessageExact = Expect<Equal<z.infer<typeof sendMessageDataSchema>, SendMessage>>;

const cancelStreamDataSchema = z
  .object({
    sessionId: boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH).optional(),
    streamId: boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH).optional(),
  })
  .refine(
    (data) => data.sessionId !== undefined || data.streamId !== undefined,
    "must include sessionId or streamId",
  ) satisfies z.ZodType<CancelStream>;
type _CancelStreamExact = Expect<Equal<z.infer<typeof cancelStreamDataSchema>, CancelStream>>;

// acceptPatch / rejectPatch:id 或 reviewBatchId 至少一个非空(跨字段约束)。
const patchRefRefine = (data: { id?: string; reviewBatchId?: string }): boolean =>
  (typeof data.id === "string" && data.id.length > 0) ||
  (typeof data.reviewBatchId === "string" && data.reviewBatchId.length > 0);

const acceptPatchDataSchema = z
  .object({ id: z.string().optional(), reviewBatchId: z.string().optional() })
  .refine(patchRefRefine, "must include id or reviewBatchId") satisfies z.ZodType<AcceptPatch>;
type _AcceptPatchExact = Expect<Equal<z.infer<typeof acceptPatchDataSchema>, AcceptPatch>>;

const rejectPatchDataSchema = z
  .object({ id: z.string().optional(), reviewBatchId: z.string().optional() })
  .refine(patchRefRefine, "must include id or reviewBatchId") satisfies z.ZodType<RejectPatch>;
type _RejectPatchExact = Expect<Equal<z.infer<typeof rejectPatchDataSchema>, RejectPatch>>;

const commitPatchesDataSchema = z
  .object({
    ids: z.array(boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH)).max(MAX_COMMAND_ARRAY_LENGTH),
    reviewBatchIds: z
      .array(boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH))
      .max(MAX_COMMAND_ARRAY_LENGTH)
      .optional(),
  })
  .refine(
    (data) => data.ids.length > 0 || (data.reviewBatchIds?.length ?? 0) > 0,
    "must include ids or reviewBatchIds",
  ) satisfies z.ZodType<CommitPatches>;
type _CommitPatchesExact = Expect<Equal<z.infer<typeof commitPatchesDataSchema>, CommitPatches>>;

const commitReviewGroupsDataSchema = z
  .object({
    acceptReviewBatchIds: z
      .array(boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH))
      .max(MAX_COMMAND_ARRAY_LENGTH),
    rejectReviewBatchIds: z
      .array(boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH))
      .max(MAX_COMMAND_ARRAY_LENGTH)
      .optional(),
    keepPendingReviewBatchIds: z
      .array(boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH))
      .max(MAX_COMMAND_ARRAY_LENGTH)
      .optional(),
  })
  .refine(
    (data) => {
      const accepted = new Set(data.acceptReviewBatchIds);
      return !(data.rejectReviewBatchIds ?? []).some((id) => accepted.has(id));
    },
    {
      path: ["rejectReviewBatchIds"],
      message: "must not overlap with acceptReviewBatchIds",
    },
  )
  .refine(
    (data) => {
      const accepted = new Set(data.acceptReviewBatchIds);
      return !(data.keepPendingReviewBatchIds ?? []).some((id) => accepted.has(id));
    },
    {
      path: ["keepPendingReviewBatchIds"],
      message: "must not overlap with acceptReviewBatchIds",
    },
  )
  .refine(
    (data) => {
      const rejected = new Set(data.rejectReviewBatchIds ?? []);
      return !(data.keepPendingReviewBatchIds ?? []).some((id) => rejected.has(id));
    },
    {
      path: ["keepPendingReviewBatchIds"],
      message: "must not overlap with rejectReviewBatchIds",
    },
  ) satisfies z.ZodType<CommitReviewGroups>;
type _CommitReviewGroupsExact = Expect<
  Equal<z.infer<typeof commitReviewGroupsDataSchema>, CommitReviewGroups>
>;

const reviewOutcomeHunkSchema = z.object({
  verdict: z.enum(["accepted", "rejected"]),
  blockSummary: z.string(),
  beforeText: z.string(),
  afterText: z.string(),
});

const submitReviewOutcomeDataSchema = z.object({
  sessionId: z.string().min(1),
  outcome: z.object({
    acceptedCount: z.number().int().nonnegative(),
    rejectedCount: z.number().int().nonnegative(),
    hunks: z.array(reviewOutcomeHunkSchema),
  }),
}) satisfies z.ZodType<SubmitReviewOutcome>;
type _SubmitReviewOutcomeExact = Expect<
  Equal<z.infer<typeof submitReviewOutcomeDataSchema>, SubmitReviewOutcome>
>;

const askUserAnswerSchema = z.object({
  chosen: z.array(z.string()),
  freeText: z.string().nullable(),
  numericValue: z.number().nullable().optional(),
}) satisfies z.ZodType<AskUserAnswer>;
type _AskUserAnswerExact = Expect<Equal<z.infer<typeof askUserAnswerSchema>, AskUserAnswer>>;

const resumeAskUserDataSchema = z.object({
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
  // 值用 .optional():契约 answers 是 partial record(`{[key in string]?: AskUserAnswer}`),
  // z.record 值加 optional 才与之精确等价;旧校验本就不校验答案值形状,这里更贴近旧行为。
  answers: z
    .record(z.string(), askUserAnswerSchema.optional())
    .refine((answers) => Object.keys(answers).length > 0, "must contain at least one entry"),
}) satisfies z.ZodType<ResumeAskUser>;
type _ResumeAskUserExact = Expect<Equal<z.infer<typeof resumeAskUserDataSchema>, ResumeAskUser>>;

const cancelAskUserDataSchema = z.object({
  sessionId: z.string().min(1),
  toolCallId: z.string().min(1),
}) satisfies z.ZodType<CancelAskUser>;
type _CancelAskUserExact = Expect<Equal<z.infer<typeof cancelAskUserDataSchema>, CancelAskUser>>;

const updateDocDataSchema = z.object({
  sessionId: boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH),
  expectedDocumentSnapshot: z.number().int(),
  baseContentHash: boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH).optional(),
  legacySections: legacySectionsPassthroughSchema.optional(),
  doc: pmDocPassthroughSchema.optional(),
  clientMutationId: boundedNonEmptyString(MAX_COMMAND_STRING_LENGTH),
}) satisfies z.ZodType<UpdateDoc>;
type _UpdateDocExact = Expect<Equal<z.infer<typeof updateDocDataSchema>, UpdateDoc>>;

const updateMaterialSummaryDataSchema = z.object({
  sessionId: z.string().min(1),
  materialId: z.string().min(1),
  summary: z.string(),
}) satisfies z.ZodType<UpdateMaterialSummary>;
type _UpdateMaterialSummaryExact = Expect<
  Equal<z.infer<typeof updateMaterialSummaryDataSchema>, UpdateMaterialSummary>
>;

const removeMaterialDataSchema = z.object({
  sessionId: z.string().min(1),
  materialId: z.string().min(1),
}) satisfies z.ZodType<RemoveMaterial>;
type _RemoveMaterialExact = Expect<Equal<z.infer<typeof removeMaterialDataSchema>, RemoveMaterial>>;

const reparseMaterialDataSchema = z.object({
  sessionId: z.string().min(1),
  fileId: z.string().min(1),
}) satisfies z.ZodType<ReparseMaterial>;
type _ReparseMaterialExact = Expect<Equal<z.infer<typeof reparseMaterialDataSchema>, ReparseMaterial>>;

const attachFolderDataSchema = z.object({
  sessionId: boundedNonEmptyString(MAX_ID_LENGTH),
  requestId: boundedNonEmptyString(MAX_ID_LENGTH),
  source: z.discriminatedUnion("provider", [
    z.object({
      provider: z.literal("desktop-local"),
      selectionToken: boundedNonEmptyString(MAX_ID_LENGTH),
    }),
    z.object({
      provider: z.literal("browser-fs-access"),
      clientSourceId: boundedNonEmptyString(MAX_ID_LENGTH),
      name: boundedNonEmptyString(MAX_NAME_LENGTH),
      browserHandleKey: boundedNonEmptyString(MAX_HANDLE_LENGTH),
    }),
  ]),
}) satisfies z.ZodType<AttachFolder>;
type _AttachFolderExact = Expect<Equal<z.infer<typeof attachFolderDataSchema>, AttachFolder>>;

const detachFolderDataSchema = z.object({
  sessionId: boundedNonEmptyString(MAX_ID_LENGTH),
  folderId: boundedNonEmptyString(MAX_ID_LENGTH),
}) satisfies z.ZodType<DetachFolder>;
type _DetachFolderExact = Expect<Equal<z.infer<typeof detachFolderDataSchema>, DetachFolder>>;

const externalProposeOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fullDraft"), markdown: z.string() }),
  z.object({
    kind: z.literal("strReplace"),
    old: z.string().min(1),
    new: z.string(),
    nth: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("insertAfterLine"),
    line: z.number().int().positive(),
    markdown: z.string(),
  }),
  z.object({ kind: z.literal("appendSection"), markdown: z.string() }),
]) satisfies z.ZodType<ExternalProposeOp>;
type _ExternalProposeOpExact = Expect<Equal<z.infer<typeof externalProposeOpSchema>, ExternalProposeOp>>;

const externalProposeDataSchema = z
  .object({
    sessionId: z.string().min(1),
    expectedDocVersion: z.number().int().nonnegative(),
    clientMutationId: z.string().min(1).optional(),
    ops: z.array(externalProposeOpSchema).min(1).max(50),
  })
  .refine((data) => {
    const fullDraftCount = data.ops.filter((op) => op.kind === "fullDraft").length;
    return fullDraftCount === 0 || (fullDraftCount === 1 && data.ops.length === 1);
  }, "fullDraft must not be mixed with other ops") satisfies z.ZodType<ExternalPropose>;
type _ExternalProposeExact = Expect<Equal<z.infer<typeof externalProposeDataSchema>, ExternalPropose>>;

// ---- 顶层 Command 联合 ----

/**
 * 全部合法 command kind。顺序/内容与 `Command.ts` 的 tagged union 一一对应,
 * 用编译期断言强制不漂移。server 侧判"未知 kind"复用它。
 */
export const COMMAND_KINDS = [
  "startSession",
  "sendMessage",
  "cancelStream",
  "acceptPatch",
  "rejectPatch",
  "commitPatches",
  "commitReviewGroups",
  "submitReviewOutcome",
  "resumeAskUser",
  "cancelAskUser",
  "updateDoc",
  "updateMaterialSummary",
  "removeMaterial",
  "reparseMaterial",
  "attachFolder",
  "detachFolder",
  "externalPropose",
  "listLexicons",
  "listLexiconEntries",
  "renameSession",
  "listDerivatives",
  "createDerivative",
  "generateTranslations",
  "deleteDerivative",
  "getDerivativeDoc",
  "listStyleTemplates",
  "getStyleTemplate",
  "saveStyleTemplate",
  "deleteStyleTemplate",
  "updateDerivativeParams",
  "listReviewTemplates",
  "saveReviewTemplate",
  "deleteReviewTemplate",
  "selectReviewTemplate",
  "getReviewSupplement",
  "upsertReviewSupplement",
  "draftTemplate",
  "ignoreAnnotationGroups",
] as const;
type _CommandKindsExact = Expect<Equal<(typeof COMMAND_KINDS)[number], Command["kind"]>>;

export const COMMAND_KIND_SET: ReadonlySet<string> = new Set(COMMAND_KINDS);

/**
 * 入站命令联合。`z.discriminatedUnion("kind", …)`:未知 kind → discriminator 错(→ 400);
 * 默认 strip 未知字段(handler 用 parse 输出即天然消毒,消解 __proto__ 一类脏键)。
 */
export const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("startSession"), data: startSessionDataSchema }),
  z.object({ kind: z.literal("sendMessage"), data: sendMessageDataSchema }),
  z.object({ kind: z.literal("cancelStream"), data: cancelStreamDataSchema }),
  z.object({ kind: z.literal("acceptPatch"), data: acceptPatchDataSchema }),
  z.object({ kind: z.literal("rejectPatch"), data: rejectPatchDataSchema }),
  z.object({ kind: z.literal("commitPatches"), data: commitPatchesDataSchema }),
  z.object({ kind: z.literal("commitReviewGroups"), data: commitReviewGroupsDataSchema }),
  z.object({ kind: z.literal("submitReviewOutcome"), data: submitReviewOutcomeDataSchema }),
  z.object({ kind: z.literal("resumeAskUser"), data: resumeAskUserDataSchema }),
  z.object({ kind: z.literal("cancelAskUser"), data: cancelAskUserDataSchema }),
  z.object({ kind: z.literal("updateDoc"), data: updateDocDataSchema }),
  z.object({ kind: z.literal("updateMaterialSummary"), data: updateMaterialSummaryDataSchema }),
  z.object({ kind: z.literal("removeMaterial"), data: removeMaterialDataSchema }),
  z.object({ kind: z.literal("reparseMaterial"), data: reparseMaterialDataSchema }),
  z.object({ kind: z.literal("attachFolder"), data: attachFolderDataSchema }),
  z.object({ kind: z.literal("detachFolder"), data: detachFolderDataSchema }),
  z.object({ kind: z.literal("externalPropose"), data: externalProposeDataSchema }),
  z.object({ kind: z.literal("listLexicons"), data: z.object({ sessionId: z.string().min(1) }) }),
  z.object({ kind: z.literal("listLexiconEntries"), data: z.object({ sessionId: z.string().min(1), resourceId: z.string().min(1) }) }),
  z.object({ kind: z.literal("renameSession"), data: z.object({ sessionId: z.string().min(1), title: z.string().trim().min(1).max(48) }) }),
  z.object({ kind: z.literal("listDerivatives"), data: z.object({ sessionId: z.string().min(1), requestId: z.string().min(1) }) }),
  z.object({ kind: z.literal("createDerivative"), data: z.object({ sessionId: z.string().min(1), requestId: z.string().min(1), dtype: z.enum(["gzh", "xhs", "translate"]), templateId: z.string().min(1), writingStyleId:z.string().min(1).optional(),layoutStyleId:z.string().min(1).nullable().optional(),targetLang:z.string().trim().min(1).optional(), privatePrompt: z.string() }).superRefine((data,ctx)=>{if(data.dtype==="translate"&&!data.targetLang)ctx.addIssue({code:z.ZodIssueCode.custom,path:["targetLang"],message:"翻译稿必须指定目标语言"})}) }),
  z.object({ kind: z.literal("generateTranslations"), data: z.object({
    sessionId: z.string().min(1),
    docIds: z.array(z.string().min(1)).min(1).max(5),
  }).refine((data) => new Set(data.docIds).size === data.docIds.length, {
    path: ["docIds"],
    message: "翻译稿 id 不可重复",
  }) }),
  z.object({ kind: z.literal("deleteDerivative"), data: z.object({ sessionId: z.string().min(1), requestId: z.string().min(1), docId: z.string().min(1) }) }),
  z.object({ kind: z.literal("getDerivativeDoc"), data: z.object({ sessionId: z.string().min(1), requestId: z.string().min(1), docId: z.string().min(1) }) }),
  z.object({kind:z.literal("listStyleTemplates"),data:z.object({sessionId:z.string().min(1),requestId:z.string().min(1),dtype:z.string().optional(),slot:z.enum(["layout","writing","instruction"]).optional()})}),
  z.object({kind:z.literal("getStyleTemplate"),data:z.object({sessionId:z.string().min(1),requestId:z.string().min(1),id:z.string().min(1)})}),
  z.object({kind:z.literal("saveStyleTemplate"),data:z.object({sessionId:z.string().min(1),requestId:z.string().min(1),id:z.string().optional(),dtype:z.string().min(1),slot:z.enum(["layout","writing","instruction"]),name:z.string().min(1),detail:z.string().optional(),prompt:z.string()})}),
  z.object({kind:z.literal("deleteStyleTemplate"),data:z.object({sessionId:z.string().min(1),requestId:z.string().min(1),id:z.string().min(1)})}),
  z.object({kind:z.literal("updateDerivativeParams"),data:z.object({sessionId:z.string().min(1),requestId:z.string().min(1),docId:z.string().min(1),layoutStyleId:z.string().min(1).optional(),writingStyleId:z.string().min(1).optional(),privatePrompt:z.string().optional(),coverTemplate:z.enum(["poster","magazine","wenkai","impact","note"]).optional()})}),
  z.object({kind:z.literal("listReviewTemplates"),data:z.object({sessionId:z.string().min(1),requestId:z.string().min(1),type:reviewTypeSchema})}),
  z.object({kind:z.literal("saveReviewTemplate"),data:z.object({sessionId:z.string().min(1),requestId:z.string().min(1),id:z.string().min(1).optional(),type:reviewTypeSchema,name:z.string().trim().min(1),prompt:z.string().trim().min(1)})}),
  z.object({kind:z.literal("deleteReviewTemplate"),data:z.object({sessionId:z.string().min(1),requestId:z.string().min(1),id:z.string().min(1)})}),
  z.object({kind:z.literal("selectReviewTemplate"),data:z.object({sessionId:z.string().min(1),requestId:z.string().min(1),type:reviewTypeSchema,templateId:z.string().min(1)})}),
  z.object({kind:z.literal("getReviewSupplement"),data:z.object({sessionId:z.string().min(1),requestId:z.string().min(1),type:reviewTypeSchema})}),
  z.object({kind:z.literal("upsertReviewSupplement"),data:z.object({sessionId:z.string().min(1),requestId:z.string().min(1),type:reviewTypeSchema,supplement:z.string()})}),
  z.object({kind:z.literal("draftTemplate"),data:z.object({
    sessionId:z.string().min(1), requestId:z.string().min(1),
    scene:z.discriminatedUnion("kind",[
      z.object({kind:z.literal("review"),type:reviewTypeSchema,label:z.string().trim().min(1)}),
      z.object({kind:z.literal("derivative"),dtype:z.enum(["gzh","xhs","translate"]),slot:z.enum(["writing","layout"]),label:z.string().trim().min(1)}),
    ]),
    intent:z.object({name:z.string(),prompt:z.string()}),
  })}),
  z.object({ kind: z.literal("ignoreAnnotationGroups"), data: ignoreAnnotationGroupsDataSchema }),
]) satisfies z.ZodType<Command>;
type _CommandExact = Expect<Equal<z.infer<typeof commandSchema>, Command>>;
