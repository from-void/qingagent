import type { AcceptPatch } from "./AcceptPatch";
import type { CancelAskUser } from "./CancelAskUser";
import type { CancelStream } from "./CancelStream";
import type { CommitPatches } from "./CommitPatches";
import type { CommitReviewGroups } from "./CommitReviewGroups";
import type { AttachFolder, DetachFolder } from "./FolderSource";
import type { RejectPatch } from "./RejectPatch";
import type { RemoveMaterial } from "./RemoveMaterial";
import type { ReparseMaterial } from "./ReparseMaterial";
import type { ResumeAskUser } from "./ResumeAskUser";
import type { SendMessage } from "./SendMessage";
import type { StartSession } from "./StartSession";
import type { SubmitReviewOutcome } from "./SubmitReviewOutcome";
import type { UpdateDoc } from "./UpdateDoc";
import type { UpdateMaterialSummary } from "./UpdateMaterialSummary";
import type { ExternalPropose } from "./ExternalPropose";

/**
 * Tagged union over every command kind. Wire format:
 * `{ "kind": "sendMessage", "data": { ... } }`.
 */
export type Command = { "kind": "startSession", "data": StartSession } | { "kind": "sendMessage", "data": SendMessage } | { "kind": "cancelStream", "data": CancelStream } | { "kind": "acceptPatch", "data": AcceptPatch } | { "kind": "rejectPatch", "data": RejectPatch } | { "kind": "commitPatches", "data": CommitPatches } | { "kind": "commitReviewGroups", "data": CommitReviewGroups } | { "kind": "submitReviewOutcome", "data": SubmitReviewOutcome } | { "kind": "resumeAskUser", "data": ResumeAskUser } | { "kind": "cancelAskUser", "data": CancelAskUser } | { "kind": "updateDoc", "data": UpdateDoc } | { "kind": "updateMaterialSummary", "data": UpdateMaterialSummary } | { "kind": "removeMaterial", "data": RemoveMaterial } | { "kind": "reparseMaterial", "data": ReparseMaterial } | { "kind": "attachFolder", "data": AttachFolder } | { "kind": "detachFolder", "data": DetachFolder } | { "kind": "externalPropose", "data": ExternalPropose };
