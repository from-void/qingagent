/** jsdom 未实现 ResizeObserver；统一桩避免 DOM 测试依赖文件执行顺序。 */
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverStub,
  });
}
