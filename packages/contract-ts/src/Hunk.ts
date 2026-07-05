import type { HunkOp } from "./HunkOp";
import type { LineRange } from "./LineRange";

export type Hunk = { rangeOld: LineRange, rangeNew: LineRange, ops: Array<HunkOp>, };
