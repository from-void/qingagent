function inlineComputedStyles(source: Element, clone: Element): void {
  if (source instanceof HTMLElement && clone instanceof HTMLElement) {
    const computed = getComputedStyle(source);
    for (const property of Array.from(computed)) {
      clone.style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property));
    }
  }
  Array.from(source.children).forEach((child, index) => {
    const clonedChild = clone.children[index];
    if (clonedChild) inlineComputedStyles(child, clonedChild);
  });
}

export async function exportElementAsPng(element: HTMLElement, filename: string): Promise<void> {
  await document.fonts?.ready;
  const rect = element.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width || element.scrollWidth));
  const height = Math.max(1, Math.ceil(rect.height || element.scrollHeight));
  const clone = element.cloneNode(true) as HTMLElement;
  inlineComputedStyles(element, clone);
  clone.style.margin = "0";
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  const markup = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${markup}</div></foreignObject></svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图片渲染失败"));
      image.src = url;
    });
    const scale = Math.min(2, 4096 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持图片导出");
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG 编码失败")), "image/png"));
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = `${filename.replace(/[\\/:*?"<>|]/g, "-")}.png`;
    anchor.click();
    URL.revokeObjectURL(downloadUrl);
  } finally {
    URL.revokeObjectURL(url);
  }
}
