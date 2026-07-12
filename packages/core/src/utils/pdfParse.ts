type PdfTextResult = {
  text: string;
  total: number;
};

type PdfInfoResult = {
  info?: {
    Title?: string;
  };
};

export type PdfParseConstructor = new (options: { data: Uint8Array }) => {
  getText(): Promise<PdfTextResult>;
  getInfo(): Promise<PdfInfoResult>;
  destroy(): Promise<void> | void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function loadPdfParseConstructor(): Promise<PdfParseConstructor> {
  const mod = await import("pdf-parse");
  const moduleRecord: Record<string, unknown> = mod;
  const defaultExport = moduleRecord.default;
  const PDFParse =
    moduleRecord.PDFParse ??
    (isRecord(defaultExport) ? defaultExport.PDFParse : undefined) ??
    defaultExport;

  if (typeof PDFParse !== "function") {
    throw new Error("PDF 解析库不可用：无法从 pdf-parse 导出中找到 PDFParse 构造器");
  }

  return PDFParse as PdfParseConstructor;
}
