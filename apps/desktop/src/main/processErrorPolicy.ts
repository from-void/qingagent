export function hasOtherProcessErrorHandler(listenerCount: number): boolean {
  // telemetry 自身通过 prependListener 注册，也会计入实时监听器数量。
  return listenerCount > 1;
}
