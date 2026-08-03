export function annotationRemovalToastMessage(count: number): string {
  return count === 1
    ? "有 1 条批注的原文已被修改，该批注已自动移除"
    : `有 ${count} 条批注的原文已被修改，已自动移除`;
}
