import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BlockPatchInput } from "../data/protocol";
import type { PatchMeta } from "../data/patchMeta";
import type { RevealPresentationRuntimeConfig } from "../data/revealPresentationConfig";
import {
  planRevealTypewriter,
  revealNewPartLen,
} from "../data/revealTypewriter";
import {
  buildReviewTableRevealPlan,
  reconcileFinalizedReviewTablePatchIds,
  reviewTableTypedCounts,
  type ReviewTableTypedByPatch,
} from "../data/tableTypewriter";

export function diagramBlockPatchIds(
  inputs: readonly BlockPatchInput[],
): ReadonlySet<string> {
  return new Set(
    inputs
      .filter((patch) =>
        patch.blocks.some((block) => block.kind === "diagram"),
      )
      .map((patch) => patch.patchId),
  );
}

export function reviewTextRevealTarget(
  id: string,
  diagramPatchIds: ReadonlySet<string>,
  patchMeta: ReadonlyMap<string, PatchMeta>,
): number {
  if (diagramPatchIds.has(id)) return 0;
  const patch = patchMeta.get(id);
  return patch ? revealNewPartLen(patch.before, patch.after) : 0;
}

export function useReviewReveal(input: {
  enabled: boolean;
  applied: readonly { id: string }[];
  blockPatchInputs: readonly BlockPatchInput[];
  patchMeta: ReadonlyMap<string, PatchMeta>;
  reducedMotion: boolean;
  config: RevealPresentationRuntimeConfig;
  replayNonce: number;
}) {
  const [revealedPatchIds, setRevealedPatchIds] =
    useState<ReadonlySet<string> | null>(null);
  const [typedByPatch, setTypedByPatch] = useState<ReadonlyMap<
    string,
    number
  > | null>(null);
  const [tableTypedByPatch, setTableTypedByPatch] =
    useState<ReviewTableTypedByPatch | null>(null);
  const [revealCursors, setRevealCursors] = useState<
    ReadonlyMap<string, number>
  >(() => new Map());
  const [patchRevealing, setPatchRevealing] = useState(false);
  const finalizedTablePatchIdsRef = useRef<Set<string>>(new Set());
  const tableRevealReplayNonceRef = useRef(input.replayNonce);

  const finalizeReviewTablePatch = useCallback((patchId: string) => {
    finalizedTablePatchIdsRef.current.add(patchId);
    setTableTypedByPatch((current) => {
      if (!current?.has(patchId)) return current;
      const next = new Map(current);
      next.delete(patchId);
      return next.size > 0 ? next : null;
    });
  }, []);

  const appliedIdsKey = useMemo(
    () => input.applied.map((patch) => patch.id).join(","),
    [input.applied],
  );
  const tableBlockPatchIds = useMemo(
    () =>
      new Set(
        input.blockPatchInputs
          .filter(
            (patch) =>
              patch.op !== "delete" &&
              patch.blocks.some((block) => block.kind === "table"),
          )
          .map((patch) => patch.patchId),
      ),
    [input.blockPatchInputs],
  );
  const diagramPatchIds = useMemo(
    () => diagramBlockPatchIds(input.blockPatchInputs),
    [input.blockPatchInputs],
  );
  const tableRevealPlans = useMemo(
    () =>
      input.blockPatchInputs.flatMap((patch) => {
        const plan = buildReviewTableRevealPlan(patch);
        return plan ? [plan] : [];
      }),
    [input.blockPatchInputs],
  );
  const tableBlockPatchIdsKey = useMemo(
    () => Array.from(tableBlockPatchIds).sort().join(","),
    [tableBlockPatchIds],
  );
  const diagramPatchIdsKey = useMemo(
    () => Array.from(diagramPatchIds).sort().join(","),
    [diagramPatchIds],
  );
  const tableRevealPlansKey = useMemo(
    () =>
      tableRevealPlans
        .map(
          (plan) =>
            `${plan.patchId}:${plan.cells.map((cell) => `${cell.key}=${cell.graphemeCount}`).join("|")}`,
        )
        .sort()
        .join(","),
    [tableRevealPlans],
  );
  const patchMetaRef = useRef(input.patchMeta);
  patchMetaRef.current = input.patchMeta;

  const {
    concurrency,
    stepDelayMs: configuredStepDelayMs,
    charsPerTick,
    tailHoldMs: configuredTailHoldMs,
  } = input.config;

  useEffect(() => {
    if (!input.enabled || appliedIdsKey === "") {
      setRevealedPatchIds(null);
      setTypedByPatch(null);
      setRevealCursors(new Map());
      setTableTypedByPatch(null);
      finalizedTablePatchIdsRef.current.clear();
      setPatchRevealing(false);
      return;
    }
    const ids = appliedIdsKey.split(",");
    const replayChanged =
      tableRevealReplayNonceRef.current !== input.replayNonce;
    finalizedTablePatchIdsRef.current = reconcileFinalizedReviewTablePatchIds(
      finalizedTablePatchIdsRef.current,
      ids,
      replayChanged,
    );
    tableRevealReplayNonceRef.current = input.replayNonce;
    if (input.reducedMotion) {
      setRevealedPatchIds(new Set(ids));
      setTypedByPatch(null);
      setRevealCursors(new Map());
      setTableTypedByPatch(null);
      setPatchRevealing(false);
      return;
    }
    const stepDelayMs = Math.max(20, configuredStepDelayMs);
    const tailHoldMs = Math.max(0, configuredTailHoldMs);
    const meta = patchMetaRef.current;
    const tablePlanByPatchId = new Map(
      tableRevealPlans.map((plan) => [plan.patchId, plan]),
    );
    const targetOf = (id: string): number => {
      if (diagramPatchIds.has(id)) return 0;
      if (tableBlockPatchIds.has(id)) {
        if (finalizedTablePatchIdsRef.current.has(id)) return 0;
        return tablePlanByPatchId.get(id)?.totalGraphemes ?? 0;
      }
      return reviewTextRevealTarget(id, diagramPatchIds, meta);
    };
    const frames = planRevealTypewriter(
      ids,
      targetOf,
      concurrency,
      charsPerTick,
    );
    const applyFrame = (frame: (typeof frames)[number]) => {
      const typedFrame = new Map(frame.typed);
      setRevealedPatchIds(new Set(frame.revealed));
      setTypedByPatch(
        new Map(
          Array.from(frame.typed).filter(
            ([patchId]) => !tableBlockPatchIds.has(patchId),
          ),
        ),
      );
      const nextTableTyped = new Map<string, ReadonlyMap<string, number>>();
      for (const plan of tableRevealPlans) {
        if (
          !frame.revealed.includes(plan.patchId) ||
          finalizedTablePatchIdsRef.current.has(plan.patchId)
        )
          continue;
        nextTableTyped.set(
          plan.patchId,
          reviewTableTypedCounts(plan, typedFrame.get(plan.patchId) ?? 0),
        );
      }
      setTableTypedByPatch(nextTableTyped.size > 0 ? nextTableTyped : null);
      setRevealCursors(
        new Map(frame.cursors.map((cursor) => [cursor.id, cursor.lane])),
      );
    };

    setPatchRevealing(true);
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      endTimer = setTimeout(() => {
        setRevealCursors(new Map());
        setTableTypedByPatch(null);
        setPatchRevealing(false);
      }, tailHoldMs);
    };

    applyFrame(frames[0]!);
    if (frames.length <= 1) {
      finish();
      return () => {
        if (endTimer) clearTimeout(endTimer);
      };
    }

    let index = 1;
    const timer = setInterval(() => {
      applyFrame(frames[index]!);
      index += 1;
      if (index >= frames.length) {
        clearInterval(timer);
        finish();
      }
    }, stepDelayMs);

    return () => {
      clearInterval(timer);
      if (endTimer) clearTimeout(endTimer);
    };
  }, [
    input.enabled,
    appliedIdsKey,
    input.reducedMotion,
    concurrency,
    configuredStepDelayMs,
    charsPerTick,
    configuredTailHoldMs,
    tableBlockPatchIdsKey,
    diagramPatchIdsKey,
    tableRevealPlansKey,
    input.replayNonce,
  ]);

  return {
    finalizeReviewTablePatch,
    patchRevealing,
    revealCursors,
    revealedPatchIds,
    setTableTypedByPatch,
    tableTypedByPatch,
    typedByPatch,
  };
}
