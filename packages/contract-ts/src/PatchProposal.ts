import type { Hunk } from "./Hunk";
import type { PatchStatus } from "./PatchStatus";

export type PatchProposal = { id: string, file: string, hunks: Array<Hunk>, status: PatchStatus, };
