import type { AskUserAnswer } from "./AskUserAnswer";
import type { ResourceRef } from "./ResourceRef";

export type ToolCallResult = { "kind": "askUserAnswers", "data": { [key in string]?: AskUserAnswer } } | { "kind": "producedResource", "data": { resourceRef: ResourceRef, } } | { "kind": "subAgentCompleted", "data": { subAgentId: string, } } | { "kind": "genericText", "data": string };
