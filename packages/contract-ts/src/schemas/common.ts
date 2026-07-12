import { z } from "zod";
import type { ChatChip } from "../ChatChip";
import type { ChatChipKind } from "../ChatChipKind";
import type { ResourceDomain } from "../ResourceDomain";
import type { ResourceRef } from "../ResourceRef";
import type { SkillRef } from "../SkillRef";
import type { TableSelection } from "../TableSelection";
import type { Equal, Expect } from "./typeAssert";

/**
 * 有界非空字符串:对应旧手写校验 `validateNonEmptyBoundedString`
 * (`packages/server/src/routes/stream.ts`)——必须是非空字符串且长度 ≤ max。
 */
export function boundedNonEmptyString(max: number): z.ZodString {
  return z.string().min(1).max(max);
}

/**
 * 上传文件 id 校验。UUID 正则从 `packages/server/src/lib/uploadStorage.ts` 的
 * `isValidUploadId`/`UUID_RE` **逐字复制**——contract-ts 不得 import server(避免反向依赖边)。
 * 两处若要改动须同步(纯逻辑,无外部状态)。
 */
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUploadId(fileId: string): boolean {
  return UPLOAD_ID_RE.test(fileId);
}

/** 单个上传文件 id:字符串且形如 UUID(对应旧 fileIds[] 逐元素校验)。 */
export const uploadIdSchema = z
  .string()
  .refine(isValidUploadId, "must be a valid UUID");

/**
 * 资源域(10 域)。以 discriminatedUnion 精确建模 `{ kind: "file" } | ...`,
 * 与契约 `ResourceDomain` 逐一对应。
 */
export const resourceDomainSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file") }),
  z.object({ kind: z.literal("image") }),
  z.object({ kind: z.literal("url") }),
  z.object({ kind: z.literal("source") }),
  z.object({ kind: z.literal("docSpan") }),
  z.object({ kind: z.literal("docPosition") }),
  z.object({ kind: z.literal("version") }),
  z.object({ kind: z.literal("mention") }),
  z.object({ kind: z.literal("citation") }),
  z.object({ kind: z.literal("webpage") }),
]) satisfies z.ZodType<ResourceDomain>;
type _ResourceDomainExact = Expect<Equal<z.infer<typeof resourceDomainSchema>, ResourceDomain>>;

/** 通用资源引用(Principle A)。 */
export const resourceRefSchema = z.object({
  id: z.string(),
  domain: resourceDomainSchema,
}) satisfies z.ZodType<ResourceRef>;
type _ResourceRefExact = Expect<Equal<z.infer<typeof resourceRefSchema>, ResourceRef>>;

/** 技能引用。 */
export const skillRefSchema = z.object({
  id: z.string(),
  version: z.string().nullable(),
}) satisfies z.ZodType<SkillRef>;
type _SkillRefExact = Expect<Equal<z.infer<typeof skillRefSchema>, SkillRef>>;

/** 对话 chip 种类(6 种)。 */
export const chatChipKindSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selection") }),
  z.object({ kind: z.literal("insertion") }),
  z.object({ kind: z.literal("attach") }),
  z.object({ kind: z.literal("mention") }),
  z.object({ kind: z.literal("skill") }),
  z.object({ kind: z.literal("text") }),
]) satisfies z.ZodType<ChatChipKind>;
type _ChatChipKindExact = Expect<Equal<z.infer<typeof chatChipKindSchema>, ChatChipKind>>;

export const tableSelectionSchema = z.object({
  axis: z.enum(["row", "column"]),
  startIndex: z.number().int().nonnegative(),
  endIndex: z.number().int().nonnegative(),
  signature: z.string().optional(),
}).refine(
  (selection) => selection.startIndex <= selection.endIndex,
  { path: ["endIndex"], message: "endIndex must be greater than or equal to startIndex" },
) satisfies z.ZodType<TableSelection>;
type _TableSelectionExact = Expect<Equal<z.infer<typeof tableSelectionSchema>, TableSelection>>;

/** 用户侧 chip 回显。 */
export const chatChipSchema = z.object({
  kind: chatChipKindSchema,
  resourceRef: resourceRefSchema.nullable(),
  skillId: z.string().optional(),
  prefix: z.string().nullable(),
  label: z.string(),
  suffix: z.string().nullable(),
  from: z.number().optional(),
  to: z.number().optional(),
  selectionRefs: z.array(z.string()).optional(),
  tableSelection: tableSelectionSchema.optional(),
  text: z.string().nullable().optional(),
}).refine(
  (chip) => chip.tableSelection === undefined || chip.kind.kind === "selection",
  { path: ["tableSelection"], message: "tableSelection is only allowed on selection chips" },
) satisfies z.ZodType<ChatChip>;
type _ChatChipExact = Expect<Equal<z.infer<typeof chatChipSchema>, ChatChip>>;
