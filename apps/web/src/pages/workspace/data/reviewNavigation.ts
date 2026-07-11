export function stepReviewTargetId(
  targetIds: readonly string[],
  activeTargetId: string | null,
  direction: "previous" | "next",
): string | null {
  if (targetIds.length === 0) return null;
  const activeIndex = activeTargetId ? targetIds.indexOf(activeTargetId) : -1;
  if (direction === "next") {
    return targetIds[activeIndex >= 0 && activeIndex < targetIds.length - 1 ? activeIndex + 1 : 0] ?? null;
  }
  return targetIds[activeIndex > 0 ? activeIndex - 1 : targetIds.length - 1] ?? null;
}
