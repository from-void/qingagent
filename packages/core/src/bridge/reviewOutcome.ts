import type { ReviewOutcome, ReviewOutcomeHunk } from "@qingagent/contract-ts";

/** 单处修改正文在喂模型时的截断上限（防止极长正文炸 token）。 */
const MAX_HUNK_TEXT = 1200;

function clip(text: string): string {
  const t = typeof text === "string" ? text : "";
  if (t.length <= MAX_HUNK_TEXT) return t;
  return `${t.slice(0, MAX_HUNK_TEXT)}…（已截断，共${t.length}字）`;
}

function renderHunk(hunk: ReviewOutcomeHunk, index: number): string {
  const head = `${index}. 【${hunk.verdict === "accepted" ? "已采纳" : "已拒绝"}】${hunk.blockSummary || "（未命名片段）"}`;
  const before = clip(hunk.beforeText);
  const after = clip(hunk.afterText);
  const afterLabel =
    hunk.verdict === "accepted" ? "你的改写（我已采纳）" : "你提出但我拒绝的改写";
  return [
    head,
    `   原文：${before || "（空）"}`,
    `   ${afterLabel}：${after || "（空）"}`,
  ].join("\n");
}

/**
 * 把一轮 diff 审核结果序列化成喂模型的中文正文（进 state.messages 的 user content）。
 *
 * 设计要点：
 * - 模型能看到每处 before/after + 采纳/拒绝，据此判断用户对哪些不满意。
 * - 引导模型自行判断是否追问：只有拒绝原因确实需要澄清时，才用对话内反问 / 轻量浮层澄清
 *   （quickClarification），**不要触发开头那种 fullpage 大问卷（initialBrief）**；
 *   不言自明则简短确认/接受即可。
 * - 明确：被拒的修改已经回滚，这只是用户反馈，不要擅自重新应用，等用户进一步指示再改。
 */
export function serializeReviewOutcome(outcome: ReviewOutcome): string {
  const hunks = Array.isArray(outcome.hunks) ? outcome.hunks : [];
  const accepted = hunks.filter((h) => h.verdict === "accepted");
  const rejected = hunks.filter((h) => h.verdict === "rejected");
  const allRejected = accepted.length === 0 && rejected.length > 0;

  const lines: string[] = [];
  lines.push(
    `（系统：以下是我刚才对你上一轮修改的审核结果，请据此与我沟通。）`,
  );
  lines.push(
    allRejected
      ? `我**拒绝了你这一轮的全部 ${rejected.length} 处修改**（这些改动已还原，文档保持原样）。`
      : `我采纳了 ${accepted.length} 处修改、拒绝了 ${rejected.length} 处修改（被拒的已还原，采纳的已生效）。`,
  );

  if (accepted.length > 0) {
    lines.push("");
    lines.push("【我采纳的修改】");
    accepted.forEach((h, i) => lines.push(renderHunk(h, i + 1)));
  }
  if (rejected.length > 0) {
    lines.push("");
    lines.push("【我拒绝的修改（这是你刚才提出、但我没有接受的改动，已还原）】");
    rejected.forEach((h, i) => lines.push(renderHunk(h, i + 1)));
  }

  lines.push("");
  lines.push("【请你这样回应】");
  lines.push(
    "- 上面这些状态已经定稿：我采纳的已生效保存、我拒绝的已还原。你**不需要、也不要**再调用任何修改/编辑/提交类工具去重做或重新提交，这一轮的落盘已经完成。",
  );
  lines.push(
    "- 别说“我没有成功提交/修改失败”之类的话——提交是我（用户）刚刚完成的，不是你要做的事。现在的任务只是和我沟通、弄清我想怎么改，别再去改动文档。",
  );
  lines.push(
    "- 不要擅自重新应用我拒绝的改动；这只是我的反馈，等我进一步明确说要改时再动手。",
  );
  if (rejected.length > 0) {
    lines.push(
      "- 关键语义：上面【我拒绝的修改】不是我想要的改法，而是你提出后被我拒绝的改法。若需要澄清，只能问我为什么不想应用这些改动、哪里不满意、或更希望往什么方向处理；严禁把被拒改动当成我的主动意图来追问动机、目的或改写收益。",
    );
  }
  if (rejected.length > 0 && rejected.length <= 3) {
    lines.push(
      "- 针对被拒的少数几处，请你自行判断是否需要继续澄清：如果拒绝原因不言自明，简短确认/接受反馈即可，不要为了问而问；如果确实需要我拍板，可选择调用 askUser 工具、purpose 填 quickClarification，把“不想应用这些改动的原因 / 更希望的方向 / 是否有更好的选择”做成 1-3 个关键问题。它会渲染成对话区的轻量反问浮层（不是开写前那种整页大问卷）。",
    );
  } else if (rejected.length > 3) {
    lines.push(
      "- 被拒的地方较多：先自行归纳反馈，别逐条追问、也别在正文里堆一长串选项。如果确实需要我补充，请我挑出最在意的一两处、或说明整体方向；若要给选项，可选择用 askUser(quickClarification) 浮层给少量几个，别弄成整页大问卷。若拒绝意图已经清楚，直接接受反馈即可。",
    );
  } else {
    lines.push(
      "- 我整体接受了，确认一下是否还有需要微调的地方即可，无需大动。",
    );
  }

  return lines.join("\n");
}
