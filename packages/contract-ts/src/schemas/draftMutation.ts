import { z } from "zod";
import type { EditDraftInput } from "../DraftMutation";
import type { Equal, Expect } from "./typeAssert";

export type {
  DraftMutationOp,
  EditDraftInput,
} from "../DraftMutation";

export const editDraftInputSchema = z.object({
  ops: z.array(z.discriminatedUnion("action", [
    z.object({ action: z.literal("replaceBlock"), ref: z.string(), block: z.string() }),
    z.object({
      action: z.literal("insertBlock"),
      position: z.enum(["after", "before", "start", "end"]),
      ref: z.string().optional(),
      blocks: z.string(),
    }),
    z.object({ action: z.literal("deleteBlock"), ref: z.string() }),
    z.object({ action: z.literal("replaceListItem"), ref: z.string(), item: z.string() }),
    z.object({
      action: z.literal("insertListItem"),
      parentRef: z.string(),
      at: z.enum(["before", "after", "start", "end"]),
      ref: z.string().optional(),
      item: z.string(),
    }),
    z.object({ action: z.literal("deleteListItem"), ref: z.string() }),
    z.object({
      action: z.literal("insertTableRow"),
      ref: z.string(),
      at: z.enum(["before", "after", "end"]),
      rowIndex: z.number().int().min(0).optional(),
      cells: z.string(),
    }),
    z.object({
      action: z.literal("insertTableColumn"),
      ref: z.string(),
      at: z.enum(["before", "after", "end"]),
      columnIndex: z.number().int().min(0).optional(),
      cells: z.string(),
    }),
    z.object({
      action: z.literal("deleteTableRow"),
      ref: z.string(),
      rowIndex: z.number().int().min(0),
    }),
    z.object({
      action: z.literal("deleteTableColumn"),
      ref: z.string(),
      columnIndex: z.number().int().min(0),
    }),
    z.object({
      action: z.literal("replaceText"),
      find: z.string(),
      replace: z.string(),
      all: z.boolean().optional(),
      isRegex: z.boolean().optional(),
      withinRef: z.string().optional(),
    }),
    z.object({
      action: z.literal("markText"),
      find: z.string(),
      mark: z.unknown(),
      op: z.enum(["add", "remove"]),
      all: z.boolean().optional(),
      isRegex: z.boolean().optional(),
      withinRef: z.string().optional(),
    }),
  ])).min(1),
}) satisfies z.ZodType<EditDraftInput>;
type _EditDraftInputExact = Expect<Equal<z.infer<typeof editDraftInputSchema>, EditDraftInput>>;
