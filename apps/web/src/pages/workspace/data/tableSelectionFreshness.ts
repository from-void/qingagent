import { tableSelectionTextSignature } from "@qingagent/contract-ts";
import { pmTableSelectionCellTexts, type PmDoc } from "@qingagent/pm-schema";
import type { ChatInputSnapshot } from "../components/ChatInput";

export function staleTableSelectionChipIndices(
  snapshot: Pick<ChatInputSnapshot, "chips">,
  doc: PmDoc,
): number[] {
  const stale: number[] = [];
  snapshot.chips.forEach((chip, index) => {
    if (!chip.tableSelection) return;
    const cellTexts = chip.blockId
      ? pmTableSelectionCellTexts(doc, chip.blockId, chip.tableSelection)
      : null;
    const currentSignature = cellTexts ? tableSelectionTextSignature(cellTexts) : null;
    if (!chip.tableSelection.signature || currentSignature !== chip.tableSelection.signature) {
      stale.push(index);
    }
  });
  return stale;
}
