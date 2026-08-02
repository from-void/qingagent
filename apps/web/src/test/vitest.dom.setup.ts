/** jsdom 未实现 ResizeObserver；统一桩避免 DOM 测试依赖文件执行顺序。 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

/** jsdom 的 Range 没有布局几何 API；ProseMirror 的选区滚动会读取它们。 */
function emptyDomRect(): DOMRect {
  return new DOMRect(0, 0, 0, 0);
}

function emptyDomRectList(): DOMRectList {
  const rects: DOMRect[] = [];
  return Object.assign(rects, {
    item: (index: number) => rects[index] ?? null,
  }) as unknown as DOMRectList;
}

for (const prototype of [Element.prototype, Range.prototype]) {
  if (typeof prototype.getClientRects !== "function") {
    Object.defineProperty(prototype, "getClientRects", {
      configurable: true,
      writable: true,
      value: emptyDomRectList,
    });
  }
  if (typeof prototype.getBoundingClientRect !== "function") {
    Object.defineProperty(prototype, "getBoundingClientRect", {
      configurable: true,
      writable: true,
      value: emptyDomRect,
    });
  }
}
