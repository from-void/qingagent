export function annotationRemovalToastMessage(count: number): string {
  return count === 1
    ? "有 1 处批注原文已变化，失效高亮已隐藏"
    : `有 ${count} 处批注原文已变化，失效高亮已隐藏`;
}
