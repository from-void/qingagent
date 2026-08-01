type PdfTextResult = {
  text: string;
  total: number;
};

type PdfInfoResult = {
  total?: number;
  info?: {
    Title?: string;
  };
};

type PdfParseParameters = {
  first?: number;
};

export type PdfParseConstructor = new (options: { data: Uint8Array }) => {
  getText(parameters?: PdfParseParameters): Promise<PdfTextResult>;
  getInfo(): Promise<PdfInfoResult>;
  destroy(): Promise<void> | void;
};

type RecoverPdfOperatorTextInput = {
  buffer: Buffer;
  primaryText: string;
  pagesToParse: number;
  signal?: AbortSignal;
};

// 正常文字层每页不足这个密度时，才读取 operator list 复核。它不是“扫描件”判定线：
// 页外文字、错误裁剪框等 PDF 仍可能有完整可解码字形，必须先完成补救再判断有无文字层。
const PDF_OPERATOR_FALLBACK_CHARS_PER_PAGE = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compactTextLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function decodeOperatorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(decodeOperatorText).join("");
  if (!isRecord(value)) return "";
  if (typeof value.unicode === "string") return value.unicode;
  if (typeof value.fontChar === "string") return value.fontChar;
  return "";
}

async function extractPdfOperatorText(
  buffer: Buffer,
  pagesToParse: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  signal?.throwIfAborted();
  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  const document = await loadingTask.promise;
  try {
    const textOperatorIds = new Set<number>([
      OPS.showText,
      OPS.showSpacedText,
      OPS.nextLineShowText,
      OPS.nextLineSetSpacingShowText,
    ]);
    const pageTexts: string[] = [];
    const lastPage = Math.min(document.numPages, Math.max(0, Math.floor(pagesToParse)));
    for (let pageNumber = 1; pageNumber <= lastPage; pageNumber += 1) {
      signal?.throwIfAborted();
      const page = await document.getPage(pageNumber);
      try {
        const operators = await page.getOperatorList();
        signal?.throwIfAborted();
        const lines: string[] = [];
        for (let index = 0; index < operators.fnArray.length; index += 1) {
          if (!textOperatorIds.has(operators.fnArray[index] ?? -1)) continue;
          const text = decodeOperatorText(operators.argsArray[index]).trimEnd();
          if (text) lines.push(text);
        }
        pageTexts.push(lines.join("\n"));
      } finally {
        page.cleanup();
      }
    }
    return pageTexts.join("\n\n").trim();
  } finally {
    await document.destroy();
  }
}

/**
 * pdf.js 的常规文字层会忽略裁剪框外/页外文字。对异常稀疏的结果读取公开 operator list，
 * 仅当底层字形明显更完整时替换主结果；补救失败不影响已经成功的常规抽取。
 */
export async function recoverPdfTextFromOperators({
  buffer,
  primaryText,
  pagesToParse,
  signal,
}: RecoverPdfOperatorTextInput): Promise<string> {
  const primaryLength = compactTextLength(primaryText);
  const expectedLength = Math.max(1, pagesToParse) * PDF_OPERATOR_FALLBACK_CHARS_PER_PAGE;
  if (primaryLength >= expectedLength) return primaryText;

  try {
    const operatorText = await extractPdfOperatorText(buffer, pagesToParse, signal);
    const operatorLength = compactTextLength(operatorText);
    const meaningfulGain = Math.max(
      primaryLength === 0 ? 1 : 20,
      Math.floor(primaryLength * 0.2),
    );
    return operatorLength >= primaryLength + meaningfulGain ? operatorText : primaryText;
  } catch (error) {
    signal?.throwIfAborted();
    return primaryText;
  }
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
