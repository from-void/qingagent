import type {
  AskUserQuestion,
  BridgeFrame,
  Command,
} from "@qingagent/contract-ts";
import {
  isPlanDraftTool,
  schedulePersist,
  type SessionState,
} from "./bridgeCore";
import { bindClientTraceId } from "./commandTracing";
import type { CommandExecutionContext } from "./commandTypes";
import { getOrRestoreSession } from "./sessionLifecycle";

type AskMoreCommand = Extract<Command, { kind: "updateAskMore" }>;

interface AskMoreQuestionInput {
  id: string;
  label: string;
  kind: { kind: "single" | "multi" | "text" };
  options: Array<{
    value: string;
    label: string;
    description?: string | null;
    preview?: string | null;
  }>;
  placeholder?: string | null;
}

export function appendAskMoreQuestions(
  session: SessionState,
  toolCallId: string,
  newQuestions: AskMoreQuestionInput[],
): boolean {
  if (newQuestions.length === 0) return false;
  for (let mi = session.chatHistory.length - 1; mi >= 0; mi--) {
    const message = session.chatHistory[mi]!;
    for (let pi = message.parts.length - 1; pi >= 0; pi--) {
      const part = message.parts[pi]!;
      if (part.kind !== "toolCall") continue;
      const spec = part.data;
      if (spec.id !== toolCallId) continue;
      if (!isPlanDraftTool(spec.name)) continue;
      if (spec.body.kind !== "askUser") continue;
      if (spec.status.kind !== "pending" && spec.status.kind !== "running") continue;
      const existing = new Set(spec.body.data.questions.map((question) => question.id));
      const appended: AskUserQuestion[] = newQuestions
        .filter((question) => !existing.has(question.id))
        .map((question) => ({
          id: question.id,
          label: question.label,
          kind: question.kind,
          options: question.options.map((option) => ({
            value: option.value,
            label: option.label,
            description: option.description ?? null,
            preview: option.preview ?? null,
          })),
          placeholder: question.placeholder ?? null,
        }));
      if (appended.length === 0) return false;
      message.parts[pi] = {
        kind: "toolCall",
        data: {
          ...spec,
          body: {
            kind: "askUser",
            data: {
              ...spec.body.data,
              questions: [...spec.body.data.questions, ...appended],
            },
          },
        },
      };
      void schedulePersist(session, "askMore").catch(() => {});
      return true;
    }
  }
  return false;
}

/** SessionActor 内执行的 askMore 两阶段状态更新；不产出主会话帧。 */
export async function* handleAskMoreCommand(
  command: AskMoreCommand,
  context: CommandExecutionContext,
): AsyncGenerator<BridgeFrame> {
  const session = await getOrRestoreSession(command.data.sessionId);
  if (!session) throw new Error(`Session not found: ${command.data.sessionId}`);
  bindClientTraceId(
    session,
    context.resolvedClientTraceId,
    context.origin,
    context.modelOverrides,
  );
  if (command.data.phase === "completed") {
    appendAskMoreQuestions(session, command.data.toolCallId, command.data.questions);
  }
}
