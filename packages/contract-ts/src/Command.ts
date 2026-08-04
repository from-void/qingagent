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
import type { UpdateAskMore } from "./UpdateAskMore";
import type { ExternalPropose } from "./ExternalPropose";
import type { ListLexiconEntries, ListLexicons, SetEnabledLexicons } from "./ListLexicons";
import type { RenameSession } from "./RenameSession";
import type { CreateDerivative, DeleteDerivative, GetDerivativeDoc, ListDerivatives, ListStyleTemplates, GetStyleTemplate, SaveStyleTemplate, DeleteStyleTemplate, UpdateDerivativeParams } from "./Derivatives";
import type { IgnoreAnnotationGroups } from "./IgnoreAnnotationGroups";
import type { DeleteReviewTemplate, GetReviewSupplement, ListReviewTemplates, SaveReviewTemplate, SelectReviewTemplate, UpsertReviewSupplement } from "./ReviewTemplates";
import type { DraftTemplate } from "./DraftTemplate";

/**
 * Tagged union over every command kind. Wire format:
 * `{ "kind": "sendMessage", "data": { ... } }`.
 */
export type Command =
  | { kind: "startSession"; data: StartSession }
  | { kind: "sendMessage"; data: SendMessage }
  | { kind: "updateAskMore"; data: UpdateAskMore }
  | { kind: "cancelStream"; data: CancelStream }
  | { kind: "acceptPatch"; data: AcceptPatch }
  | { kind: "rejectPatch"; data: RejectPatch }
  | { kind: "commitPatches"; data: CommitPatches }
  | { kind: "commitReviewGroups"; data: CommitReviewGroups }
  | { kind: "submitReviewOutcome"; data: SubmitReviewOutcome }
  | { kind: "resumeAskUser"; data: ResumeAskUser }
  | { kind: "cancelAskUser"; data: CancelAskUser }
  | { kind: "updateDoc"; data: UpdateDoc }
  | { kind: "updateMaterialSummary"; data: UpdateMaterialSummary }
  | { kind: "removeMaterial"; data: RemoveMaterial }
  | { kind: "reparseMaterial"; data: ReparseMaterial }
  | { kind: "attachFolder"; data: AttachFolder }
  | { kind: "detachFolder"; data: DetachFolder }
  | { kind: "externalPropose"; data: ExternalPropose }
  | { kind: "listLexicons"; data: ListLexicons }
  | { kind: "setEnabledLexicons"; data: SetEnabledLexicons }
  | { kind: "listLexiconEntries"; data: ListLexiconEntries }
  | { kind: "renameSession"; data: RenameSession }
  | { kind: "listDerivatives"; data: ListDerivatives }
  | { kind: "createDerivative"; data: CreateDerivative }
  | { kind: "deleteDerivative"; data: DeleteDerivative }
  | { kind: "getDerivativeDoc"; data: GetDerivativeDoc }
  | { kind: "listStyleTemplates"; data: ListStyleTemplates }
  | { kind: "getStyleTemplate"; data: GetStyleTemplate }
  | { kind: "saveStyleTemplate"; data: SaveStyleTemplate }
  | { kind: "deleteStyleTemplate"; data: DeleteStyleTemplate }
  | { kind: "updateDerivativeParams"; data: UpdateDerivativeParams }
  | { kind: "listReviewTemplates"; data: ListReviewTemplates }
  | { kind: "saveReviewTemplate"; data: SaveReviewTemplate }
  | { kind: "deleteReviewTemplate"; data: DeleteReviewTemplate }
  | { kind: "selectReviewTemplate"; data: SelectReviewTemplate }
  | { kind: "getReviewSupplement"; data: GetReviewSupplement }
  | { kind: "upsertReviewSupplement"; data: UpsertReviewSupplement }
  | { kind: "draftTemplate"; data: DraftTemplate }
  | { kind: "ignoreAnnotationGroups"; data: IgnoreAnnotationGroups };
