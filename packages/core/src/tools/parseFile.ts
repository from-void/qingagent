import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { startToolHeartbeat } from "./toolHeartbeat.js";
import { resolveFileIds } from "../bridge/uploadFileResolver.js";
import type { Document as XmlDocument, Element as XmlElement } from "@xmldom/xmldom";

type ParsedFileContent = {
  text: string;
  pages: number | null;
  indexable?: boolean;
};

export interface ParseFileBufferInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface ParseFileBufferResult {
  ok: true;
  text: string;
  metadata: {
    pages: number | null;
    wordCount: number;
    title: string | null;
    indexable: boolean;
  };
}

export interface ParseFileBufferFailure {
  ok: false;
  text: "";
  error: string;
  failureKind: "unsupported" | "error";
  metadata: {
    pages: null;
    wordCount: 0;
    title: null;
    indexable: false;
  };
}

export type ParseFileBufferOutput = ParseFileBufferResult | ParseFileBufferFailure;

type ParseFileToolResult = {
  text: string;
  metadata: {
    pages: number | null;
    wordCount: number;
    title: string | null;
  };
};

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

class UnsupportedParseFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedParseFileError";
  }
}

function isZipBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function isCsvFile(ext: string, mimeType: string): boolean {
  return ext === "csv" || /\bcsv\b/i.test(mimeType);
}

function isExcelFile(ext: string, mimeType: string): boolean {
  return (
    ext === "xlsx" ||
    ext === "xls" ||
    isCsvFile(ext, mimeType) ||
    /spreadsheet|excel/i.test(mimeType)
  );
}

function isPowerPointFile(ext: string, mimeType: string): boolean {
  return ext === "pptx" || ext === "ppt" || /presentation|powerpoint/i.test(mimeType);
}

function decodeUtf8(buffer: Buffer): string {
  return buffer.toString("utf-8");
}

function decodeUtf16be(buffer: Buffer): string {
  const swapped = Buffer.alloc(buffer.length);
  for (let index = 0; index < buffer.length; index += 2) {
    swapped[index] = buffer[index + 1] ?? 0;
    swapped[index + 1] = buffer[index] ?? 0;
  }
  return swapped.toString("utf16le");
}

function looksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) return false;
  const decoded = sample.toString("utf-8");
  return replacementCharRatio(decoded) < 0.01;
}

function assertNoNulText(text: string): string {
  if (text.includes("\u0000")) {
    throw new Error("不是可读文本或包含二进制控制字符");
  }
  return text;
}

function assertEvenUtf16Payload(buffer: Buffer): void {
  if (buffer.length % 2 !== 0) {
    throw new Error("UTF-16 文本字节长度截断");
  }
}

function replacementCharRatio(text: string): number {
  const replacementCount = [...text].filter((char) => char === "\uFFFD").length;
  return replacementCount / Math.max(text.length, 1);
}

function hasBinaryControlText(text: string): boolean {
  return /[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(text);
}

function tryDecodeLegacyChineseText(buffer: Buffer): string | null {
  for (const label of ["gb18030", "gbk"] as const) {
    let text: string;
    try {
      text = new TextDecoder(label).decode(buffer);
    } catch {
      continue;
    }
    if (replacementCharRatio(text) >= 0.001) continue;
    if (hasBinaryControlText(text)) continue;
    if (!/[\p{Script=Han}]/u.test(text)) continue;
    return text;
  }
  return null;
}

function decodeTextBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return "";
  const assertLossless = (text: string): string => {
    if (text.includes("\uFFFD")) {
      throw new Error("文本包含无法解码的替换字符");
    }
    return text;
  };
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return assertNoNulText(assertLossless(buffer.subarray(3).toString("utf-8")));
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const payload = buffer.subarray(2);
    assertEvenUtf16Payload(payload);
    return assertLossless(payload.toString("utf16le"));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const payload = buffer.subarray(2);
    assertEvenUtf16Payload(payload);
    return assertLossless(decodeUtf16be(payload));
  }
  if (buffer.includes(0)) {
    throw new Error("不是可读文本或包含二进制控制字符");
  }
  const utf8Text = decodeUtf8(buffer);
  const utf8ReplacementRatio = replacementCharRatio(utf8Text);
  if (utf8ReplacementRatio === 0) {
    return assertNoNulText(utf8Text);
  }
  if (utf8ReplacementRatio >= 0.01) {
    const legacyChineseText = tryDecodeLegacyChineseText(buffer);
    if (legacyChineseText !== null) {
      return assertNoNulText(legacyChineseText);
    }
  }
  if (!looksLikeText(buffer)) {
    throw new Error("不是可读文本或包含二进制控制字符");
  }
  return assertNoNulText(assertLossless(utf8Text));
}

function getLocalName(element: XmlElement): string {
  return element.localName || element.nodeName.split(":").pop() || element.nodeName;
}

function getElementsByLocalName(root: XmlDocument | XmlElement, localName: string): XmlElement[] {
  return Array.from(root.getElementsByTagName("*") as unknown as XmlElement[]).filter(
    (element) => getLocalName(element) === localName,
  );
}

function getChildElementsByLocalName(element: XmlElement, localName: string): XmlElement[] {
  const children: XmlElement[] = [];
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const child = node as XmlElement;
    if (getLocalName(child) === localName) children.push(child);
  }
  return children;
}

function collectDescendantText(element: XmlElement, localName: string): string {
  return getElementsByLocalName(element, localName)
    .map((node) => node.textContent ?? "")
    .join("");
}

function collectDescendantTextExcluding(
  element: XmlElement,
  localName: string,
  excludedAncestorLocalNames: ReadonlySet<string>,
): string {
  let text = "";
  const visit = (node: Node, excluded: boolean): void => {
    if (node.nodeType === 1) {
      const child = node as unknown as XmlElement;
      const nextExcluded = excluded || excludedAncestorLocalNames.has(getLocalName(child));
      if (!nextExcluded && getLocalName(child) === localName) {
        text += child.textContent ?? "";
        return;
      }
      for (let nested = child.firstChild; nested; nested = nested.nextSibling) {
        visit(nested as unknown as Node, nextExcluded);
      }
    }
  };
  for (let node = element.firstChild; node; node = node.nextSibling) {
    visit(node as unknown as Node, false);
  }
  return text;
}

async function createXmlParser() {
  const { DOMParser } = await import("@xmldom/xmldom");
  return new DOMParser({
    onError: () => undefined,
  });
}

function resolveZipPath(baseDir: string, target: string): string {
  const rawParts = target.startsWith("/")
    ? target.slice(1).split("/")
    : `${baseDir}/${target}`.split("/");
  const parts: string[] = [];
  for (const part of rawParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function parseRelationships(
  xml: string,
  parser: Awaited<ReturnType<typeof createXmlParser>>,
  baseDir: string,
) {
  const doc = parser.parseFromString(xml, "application/xml");
  const rels = new Map<string, string>();
  for (const rel of getElementsByLocalName(doc, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target) rels.set(id, resolveZipPath(baseDir, target));
  }
  return rels;
}

function parseWorkbookRelationships(xml: string, parser: Awaited<ReturnType<typeof createXmlParser>>) {
  return parseRelationships(xml, parser, "xl");
}

type ZipLike = {
  files: Record<string, unknown>;
  file(path: string): { async(type: "text"): Promise<string> } | null;
};

async function readZipText(zip: ZipLike, path: string): Promise<string | null> {
  return (await zip.file(path)?.async("text")) ?? null;
}

function zipDirName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

function zipBaseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function zipRelsPathForPart(path: string): string {
  const dir = zipDirName(path);
  const base = zipBaseName(path);
  return dir ? `${dir}/_rels/${base}.rels` : `_rels/${base}.rels`;
}

function sortOfficePartPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const aIndex = Number.parseInt(a.match(/(\d+)\.xml$/i)?.[1] ?? "0", 10);
    const bIndex = Number.parseInt(b.match(/(\d+)\.xml$/i)?.[1] ?? "0", 10);
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.localeCompare(b);
  });
}

function parseSharedStrings(xml: string, parser: Awaited<ReturnType<typeof createXmlParser>>): string[] {
  const doc = parser.parseFromString(xml, "application/xml");
  return getElementsByLocalName(doc, "si").map((item) =>
    collectDescendantTextExcluding(item, "t", new Set(["rPh"])),
  );
}

function getFirstDescendantText(element: XmlElement, localName: string): string {
  return getElementsByLocalName(element, localName)[0]?.textContent ?? "";
}

function getCellColumnIndex(cellRef: string | null): number | null {
  const letters = cellRef?.match(/^[A-Z]+/i)?.[0];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

type XlsxCellStyle = {
  numFmtId: number;
  formatCode: string | null;
  isDate: boolean;
  dateKind: XlsxDateFormatKind | null;
};

type XlsxDateFormatKind = "date" | "time" | "duration";

const BUILTIN_XLSX_NUM_FMT_CODES = new Map<number, string>([
  [1, "0"],
  [2, "0.00"],
  [3, "#,##0"],
  [4, "#,##0.00"],
  [9, "0%"],
  [10, "0.00%"],
  [11, "0.00E+00"],
  [12, "# ?/?"],
  [13, "# ??/??"],
  [14, "m/d/yy"],
  [15, "d-mmm-yy"],
  [16, "d-mmm"],
  [17, "mmm-yy"],
  [18, "h:mm AM/PM"],
  [19, "h:mm:ss AM/PM"],
  [20, "h:mm"],
  [21, "h:mm:ss"],
  [22, "m/d/yy h:mm"],
  [37, "#,##0 ;(#,##0)"],
  [38, "#,##0 ;[Red](#,##0)"],
  [39, "#,##0.00;(#,##0.00)"],
  [40, "#,##0.00;[Red](#,##0.00)"],
  [45, "mm:ss"],
  [46, "[h]:mm:ss"],
  [47, "mmss.0"],
]);

const BUILTIN_XLSX_DATE_NUM_FMT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47,
  50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

function stripQuotedAndEscapedNumFmt(formatCode: string): string {
  return formatCode
    .replace(/"([^"]|"")*"/g, "")
    .replace(/\\./g, "")
    .replace(/_.?/g, "")
    .replace(/\*.?/g, "")
    .toLowerCase();
}

function cleanNumFmtCode(formatCode: string): string {
  return stripQuotedAndEscapedNumFmt(formatCode)
    .replace(/\[[^\]]*]/g, "")
    .toLowerCase();
}

const BUILTIN_XLSX_TIME_NUM_FMT_IDS = new Set([18, 19, 20, 21, 45, 47]);
const BUILTIN_XLSX_DURATION_NUM_FMT_IDS = new Set([46]);

function xlsxDateFormatKind(numFmtId: number, formatCode: string | null): XlsxDateFormatKind | null {
  if (BUILTIN_XLSX_DURATION_NUM_FMT_IDS.has(numFmtId)) return "duration";
  if (BUILTIN_XLSX_TIME_NUM_FMT_IDS.has(numFmtId)) return "time";
  if (BUILTIN_XLSX_DATE_NUM_FMT_IDS.has(numFmtId)) return "date";
  if (!formatCode) return null;
  const detection = stripQuotedAndEscapedNumFmt(formatCode);
  if (/\[(h+|m+|s+)]/i.test(detection)) return "duration";
  const cleaned = detection.replace(/\[[^\]]*]/g, "");
  const hasYear = /y/i.test(cleaned);
  const hasDay = /d/i.test(cleaned);
  const hasHour = /h/i.test(cleaned);
  const hasSecond = /s/i.test(cleaned);
  const hasAmPm = /am\/pm|a\/p/i.test(cleaned);
  const hasMonthName = /m{3,5}/i.test(cleaned);
  if (hasYear || hasDay || hasMonthName) return "date";
  if (hasHour || hasSecond || hasAmPm) return "time";
  return null;
}

function parseXlsxStyles(xml: string, parser: Awaited<ReturnType<typeof createXmlParser>>): XlsxCellStyle[] {
  const doc = parser.parseFromString(xml, "application/xml");
  const customFormats = new Map<number, string>();
  for (const numFmt of getElementsByLocalName(doc, "numFmt")) {
    const id = Number.parseInt(numFmt.getAttribute("numFmtId") ?? "", 10);
    const code = numFmt.getAttribute("formatCode");
    if (Number.isFinite(id) && code) customFormats.set(id, code);
  }

  const cellXfs = getElementsByLocalName(doc, "cellXfs")[0];
  if (!cellXfs) return [];

  return getChildElementsByLocalName(cellXfs, "xf").map((xf) => {
    const numFmtId = Number.parseInt(xf.getAttribute("numFmtId") ?? "0", 10);
    const formatCode = customFormats.get(numFmtId) ?? BUILTIN_XLSX_NUM_FMT_CODES.get(numFmtId) ?? null;
    const dateKind = xlsxDateFormatKind(numFmtId, formatCode);
    return {
      numFmtId,
      formatCode,
      isDate: dateKind !== null,
      dateKind,
    };
  });
}

function workbookUses1904Dates(workbookDoc: XmlDocument): boolean {
  const workbookPr = getElementsByLocalName(workbookDoc, "workbookPr")[0];
  const value = workbookPr?.getAttribute("date1904");
  return value === "1" || value === "true" || value === "TRUE";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function excelSerialToDateText(rawValue: string, date1904: boolean): string {
  const serial = Number(rawValue);
  if (!Number.isFinite(serial)) return rawValue;
  const wholeDays = Math.trunc(serial);
  const fraction = serial - wholeDays;
  if (!date1904 && wholeDays === 60) {
    return Math.abs(fraction) > 1e-9 ? "1900-02-29 00:00:00" : "1900-02-29";
  }

  const adjustedSerial = date1904 ? serial : serial >= 60 ? serial - 1 : serial;
  const epochMs = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const date = new Date(epochMs + Math.round(adjustedSerial * 24 * 60 * 60 * 1000));
  const datePart = [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
  ].join("-");
  if (Math.abs(fraction) <= 1e-9) return datePart;
  return `${datePart} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

function excelSerialToTimeText(rawValue: string, formatCode: string | null): string {
  const serial = Number(rawValue);
  if (!Number.isFinite(serial)) return rawValue;
  const secondsInDay = 24 * 60 * 60;
  const fraction = ((serial % 1) + 1) % 1;
  const totalSeconds = Math.round(fraction * secondsInDay) % secondsInDay;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const section = cleanNumFmtCode(selectNumFmtSection(formatCode ?? "", serial).section);
  if (!section.includes(":") && /^m{1,2}s{2}(?:\.0+)?$/i.test(section)) {
    return `${pad2(minutes)}${pad2(seconds)}${section.includes(".") ? ".0" : ""}`;
  }
  if (!section.includes("h") && section.includes("s")) {
    return `${pad2(minutes)}:${pad2(seconds)}`;
  }
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function excelSerialToDurationText(rawValue: string, formatCode: string | null): string {
  const serial = Number(rawValue);
  if (!Number.isFinite(serial)) return rawValue;
  const sign = serial < 0 ? "-" : "";
  const totalSeconds = Math.round(Math.abs(serial) * 24 * 60 * 60);
  const section = stripQuotedAndEscapedNumFmt(selectNumFmtSection(formatCode ?? "", serial).section);
  const elapsed = section.match(/\[(h+|m+|s+)]/i)?.[1]?.toLowerCase() ?? "h";
  if (elapsed.startsWith("s")) return `${sign}${totalSeconds}`;
  if (elapsed.startsWith("m")) {
    const totalMinutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return section.includes("s") ? `${sign}${totalMinutes}:${pad2(seconds)}` : `${sign}${totalMinutes}`;
  }
  const totalHours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${sign}${totalHours}:${pad2(minutes)}:${pad2(seconds)}`;
}

function splitNumFmtSections(formatCode: string): string[] {
  const sections: string[] = [];
  let current = "";
  let inQuote = false;
  let inBracket = false;
  for (let index = 0; index < formatCode.length; index += 1) {
    const char = formatCode[index] ?? "";
    if (char === '"' && !inBracket) {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (!inQuote) {
      if (char === "[") inBracket = true;
      if (char === "]") inBracket = false;
      if (char === ";" && !inBracket) {
        sections.push(current);
        current = "";
        continue;
      }
    }
    current += char;
  }
  sections.push(current);
  return sections;
}

function selectNumFmtSection(formatCode: string, value: number): { section: string; useAbsoluteValue: boolean } {
  const sections = splitNumFmtSections(formatCode);
  if (value < 0 && sections[1] !== undefined && sections[1] !== "") {
    return { section: sections[1], useAbsoluteValue: true };
  }
  if (value === 0 && sections[2] !== undefined && sections[2] !== "") {
    return { section: sections[2], useAbsoluteValue: false };
  }
  return { section: sections[0] ?? formatCode, useAbsoluteValue: false };
}

function decimalPlacesFromFormat(formatCode: string): number {
  const section = cleanNumFmtCode(formatCode).split(/[eE]/)[0] ?? formatCode;
  const match = section.match(/\.([0#]+)/);
  return match?.[1]?.length ?? 0;
}

function exponentPlacesFromFormat(formatCode: string): number {
  const match = cleanNumFmtCode(formatCode).match(/e[+-](0+)/i);
  return match?.[1]?.length ?? 0;
}

function formatScientificNumber(value: number, section: string): string {
  const decimals = decimalPlacesFromFormat(section);
  const exponentPlaces = exponentPlacesFromFormat(section);
  const [mantissa = "0", exponent = "+0"] = value.toExponential(decimals).toUpperCase().split("E");
  const sign = exponent.startsWith("-") ? "-" : "+";
  const digits = exponent.replace(/^[+-]/, "").padStart(exponentPlaces, "0");
  return `${mantissa}E${sign}${digits}`;
}

function renderNumFmtLiteral(fragment: string): string {
  let output = "";
  for (let index = 0; index < fragment.length; index += 1) {
    const char = fragment[index] ?? "";
    if (char === '"') {
      let literal = "";
      index += 1;
      while (index < fragment.length) {
        const next = fragment[index] ?? "";
        if (next === '"') {
          if (fragment[index + 1] === '"') {
            literal += '"';
            index += 2;
            continue;
          }
          break;
        }
        literal += next;
        index += 1;
      }
      output += literal;
      continue;
    }
    if (char === "\\") {
      output += fragment[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (char === "_") {
      index += 1;
      continue;
    }
    if (char === "*") {
      index += 1;
      continue;
    }
    if (char === "[") {
      while (index < fragment.length && fragment[index] !== "]") index += 1;
      continue;
    }
    if (!/[0#?,.eE+\-\s@]/.test(char)) output += char;
  }
  return output;
}

function applyNumFmtLiterals(section: string, formattedNumber: string): string {
  const first = section.search(/[0#?]/);
  if (first < 0) return formattedNumber;
  let last = first;
  for (let index = section.length - 1; index >= first; index -= 1) {
    if (/[0#?]/.test(section[index] ?? "")) {
      last = index;
      break;
    }
  }
  const prefix = renderNumFmtLiteral(section.slice(0, first));
  const suffix = renderNumFmtLiteral(section.slice(last + 1));
  return `${prefix}${formattedNumber}${suffix}`;
}

function formatXlsxNumber(rawValue: string, style: XlsxCellStyle | undefined): string {
  if (!style?.formatCode) return rawValue;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return rawValue;
  const selected = selectNumFmtSection(style.formatCode, value);
  const section = selected.section || style.formatCode;
  const cleaned = cleanNumFmtCode(section);
  const percent = cleaned.includes("%");
  const useGrouping = cleaned.includes(",");
  const numericValue = (selected.useAbsoluteValue ? Math.abs(value) : value) * (percent ? 100 : 1);
  const formatted = /e[+-]0+/i.test(cleaned)
    ? formatScientificNumber(numericValue, section)
    : new Intl.NumberFormat("en-US", {
      useGrouping,
      minimumFractionDigits: decimalPlacesFromFormat(section),
      maximumFractionDigits: decimalPlacesFromFormat(section),
    }).format(numericValue);
  const withLiterals = applyNumFmtLiterals(section, formatted);
  return percent && !withLiterals.includes("%") ? `${withLiterals}%` : withLiterals;
}

function formulaText(cell: XmlElement): string {
  const formula = getFirstDescendantText(cell, "f").trim();
  if (!formula) return "";
  return formula.startsWith("=") ? formula : `=${formula}`;
}

function readXlsxCellText(
  cell: XmlElement,
  sharedStrings: string[],
  styles: XlsxCellStyle[],
  date1904: boolean,
): string {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") return collectDescendantTextExcluding(cell, "t", new Set(["rPh"]));

  const rawValue = getFirstDescendantText(cell, "v");
  if (!rawValue && type !== "s") {
    return formulaText(cell) || collectDescendantText(cell, "t");
  }

  if (type === "s") {
    const sharedIndex = Number.parseInt(rawValue, 10);
    return Number.isFinite(sharedIndex) ? sharedStrings[sharedIndex] ?? "" : "";
  }
  if (type === "b") return rawValue === "1" ? "TRUE" : "FALSE";
  const styleIndex = Number.parseInt(cell.getAttribute("s") ?? "", 10);
  const style = Number.isFinite(styleIndex) ? styles[styleIndex] : undefined;
  if (style?.dateKind === "time") return excelSerialToTimeText(rawValue, style.formatCode);
  if (style?.dateKind === "duration") return excelSerialToDurationText(rawValue, style.formatCode);
  if (style?.dateKind === "date") return excelSerialToDateText(rawValue, date1904);
  if (style?.formatCode) return formatXlsxNumber(rawValue, style);
  return rawValue;
}

function isOpenXmlTruthy(value: string | null): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function isHiddenXlsxRow(row: XmlElement): boolean {
  return isOpenXmlTruthy(row.getAttribute("hidden")) || isOpenXmlTruthy(row.getAttribute("zeroHeight"));
}

function isHiddenXlsxSheet(sheet: XmlElement): boolean {
  const state = sheet.getAttribute("state")?.toLowerCase();
  return state === "hidden" || state === "veryhidden";
}

function parseXlsxSheet(
  xml: string,
  parser: Awaited<ReturnType<typeof createXmlParser>>,
  sharedStrings: string[],
  styles: XlsxCellStyle[],
  date1904: boolean,
): string {
  const doc = parser.parseFromString(xml, "application/xml");
  const lines: string[] = [];

  for (const row of getElementsByLocalName(doc, "row")) {
    if (isHiddenXlsxRow(row)) continue;
    const values: string[] = [];
    for (const cell of getChildElementsByLocalName(row, "c")) {
      const cellText = readXlsxCellText(cell, sharedStrings, styles, date1904);
      const columnIndex = getCellColumnIndex(cell.getAttribute("r"));
      if (columnIndex === null) {
        values.push(cellText);
      } else {
        values[columnIndex] = cellText;
      }
    }

    while (values.length > 0 && (values[values.length - 1] ?? "") === "") values.pop();
    if (values.some((value) => value.trim().length > 0)) {
      lines.push(values.map((value) => value ?? "").join("\t"));
    }
  }

  return lines.join("\n");
}

async function parseXlsx(buffer: Buffer): Promise<ParsedFileContent> {
  if (buffer.length === 0) throw new Error("xlsx 文件为空");
  if (!isZipBuffer(buffer)) throw new Error("不是有效的 xlsx zip 包");

  const [{ default: JSZip }, parser] = await Promise.all([
    import("jszip"),
    createXmlParser(),
  ]);
  const zip = await JSZip.loadAsync(buffer);
  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) throw new Error("缺少 xl/workbook.xml");

  const workbookXml = await workbookFile.async("text");
  const workbookDoc = parser.parseFromString(workbookXml, "application/xml");
  const date1904 = workbookUses1904Dates(workbookDoc);
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("text");
  const relationships = relsXml ? parseWorkbookRelationships(relsXml, parser) : new Map<string, string>();
  const sharedStringsXml = await zip.file("xl/sharedStrings.xml")?.async("text");
  const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml, parser) : [];
  const stylesXml = await zip.file("xl/styles.xml")?.async("text");
  const styles = stylesXml ? parseXlsxStyles(stylesXml, parser) : [];

  const sheetOutputs: string[] = [];
  const sheets = getElementsByLocalName(workbookDoc, "sheet");
  if (sheets.length === 0) throw new Error("缺少有效工作表");
  for (let index = 0; index < sheets.length; index += 1) {
    const sheet = sheets[index];
    if (!sheet) continue;
    if (isHiddenXlsxSheet(sheet)) continue;
    const name = sheet.getAttribute("name") || `Sheet${index + 1}`;
    const relationshipId = sheet.getAttribute("r:id") || sheet.getAttribute("id");
    const sheetPath =
      (relationshipId ? relationships.get(relationshipId) : undefined) ??
      `xl/worksheets/sheet${index + 1}.xml`;
    const sheetXml = await zip.file(sheetPath)?.async("text");
    if (!sheetXml) continue;

    const body = parseXlsxSheet(sheetXml, parser, sharedStrings, styles, date1904);
    sheetOutputs.push([`# Sheet: ${name}`, body].filter(Boolean).join("\n"));
  }
  if (sheetOutputs.length === 0) {
    throw new Error("缺少可读工作表内容");
  }

  return { text: sheetOutputs.join("\n\n"), pages: sheetOutputs.length };
}

function parseWordTextXml(xml: string, parser: Awaited<ReturnType<typeof createXmlParser>>): string {
  const doc = parser.parseFromString(xml, "application/xml");
  const paragraphs = getElementsByLocalName(doc, "p")
    .map((paragraph) => collectDescendantText(paragraph, "t").trim())
    .filter(Boolean);
  if (paragraphs.length > 0) return paragraphs.join("\n");
  return getElementsByLocalName(doc, "t")
    .map((node) => (node.textContent ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

async function extractDocxAuxiliaryText(buffer: Buffer): Promise<string> {
  if (!isZipBuffer(buffer)) return "";
  const [{ default: JSZip }, parser] = await Promise.all([
    import("jszip"),
    createXmlParser(),
  ]);
  const zip = await JSZip.loadAsync(buffer);
  const paths = Object.keys(zip.files);
  const headerPaths = sortOfficePartPaths(paths.filter((path) => /^word\/header\d+\.xml$/i.test(path)));
  const footerPaths = sortOfficePartPaths(paths.filter((path) => /^word\/footer\d+\.xml$/i.test(path)));
  const auxiliaryPaths = [
    ...headerPaths,
    ...footerPaths,
    ...(zip.file("word/footnotes.xml") ? ["word/footnotes.xml"] : []),
    ...(zip.file("word/endnotes.xml") ? ["word/endnotes.xml"] : []),
  ];
  const chunks: string[] = [];
  for (const path of auxiliaryPaths) {
    const xml = await readZipText(zip, path);
    if (!xml) continue;
    const text = parseWordTextXml(xml, parser).trim();
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n");
}

type PptxTextBlock = {
  order: number;
  x: number | null;
  y: number | null;
  text: string;
};

function collectPptxTextBodyText(textBody: XmlElement): string {
  const paragraphs = getElementsByLocalName(textBody, "p")
    .map((paragraph) => collectDescendantText(paragraph, "t").trim())
    .filter(Boolean);
  if (paragraphs.length > 0) return paragraphs.join("\n");
  return getElementsByLocalName(textBody, "t")
    .map((node) => (node.textContent ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function findPptxTextShape(textBody: XmlElement): XmlElement | null {
  for (let node = textBody.parentNode; node; node = node.parentNode) {
    if (node.nodeType !== 1) continue;
    const element = node as XmlElement;
    const localName = getLocalName(element);
    if (localName === "sp" || localName === "cxnSp" || localName === "graphicFrame" || localName === "pic") {
      return element;
    }
    if (localName === "sld" || localName === "notes") return null;
  }
  return null;
}

function readPptxShapeOffset(shape: XmlElement | null): { x: number; y: number } | null {
  if (!shape) return null;
  for (const xfrm of getElementsByLocalName(shape, "xfrm")) {
    const off = getChildElementsByLocalName(xfrm, "off")[0] ?? getElementsByLocalName(xfrm, "off")[0];
    if (!off) continue;
    const x = Number.parseInt(off.getAttribute("x") ?? "", 10);
    const y = Number.parseInt(off.getAttribute("y") ?? "", 10);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return null;
}

function comparePptxTextBlocks(a: PptxTextBlock, b: PptxTextBlock): number {
  const aHasCoords = a.x !== null && a.y !== null;
  const bHasCoords = b.x !== null && b.y !== null;
  if (aHasCoords && bHasCoords) {
    const ay = a.y ?? 0;
    const by = b.y ?? 0;
    const ax = a.x ?? 0;
    const bx = b.x ?? 0;
    if (ay !== by) return ay - by;
    if (ax !== bx) return ax - bx;
  }
  return a.order - b.order;
}

function parsePptxSlide(xml: string, parser: Awaited<ReturnType<typeof createXmlParser>>): string {
  const doc = parser.parseFromString(xml, "application/xml");
  const blocks = getElementsByLocalName(doc, "txBody")
    .map((textBody, order): PptxTextBlock | null => {
      const text = collectPptxTextBodyText(textBody).trim();
      if (!text) return null;
      const offset = readPptxShapeOffset(findPptxTextShape(textBody));
      return {
        order,
        x: offset?.x ?? null,
        y: offset?.y ?? null,
        text,
      };
    })
    .filter((block): block is PptxTextBlock => block !== null);

  if (blocks.length > 0) {
    const sorted = blocks.some((block) => block.x !== null && block.y !== null)
      ? [...blocks].sort(comparePptxTextBlocks)
      : blocks;
    return sorted.map((block) => block.text).join("\n");
  }
  return getElementsByLocalName(doc, "t")
    .map((node) => (node.textContent ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function sortPptxSlidePaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => {
    const aIndex = Number.parseInt(a.match(/slide(\d+)\.xml/i)?.[1] ?? "0", 10);
    const bIndex = Number.parseInt(b.match(/slide(\d+)\.xml/i)?.[1] ?? "0", 10);
    return aIndex - bIndex;
  });
}

function parsePptxPresentationOrder(
  presentationXml: string,
  relsXml: string,
  parser: Awaited<ReturnType<typeof createXmlParser>>,
  availableSlidePaths: Set<string>,
): string[] | null {
  const presentationDoc = parser.parseFromString(presentationXml, "application/xml");
  const rels = parseRelationships(relsXml, parser, "ppt");
  const ids = getElementsByLocalName(presentationDoc, "sldId")
    .map((slideId) => slideId.getAttribute("r:id") || slideId.getAttribute("id"))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return null;

  const ordered: string[] = [];
  for (const id of ids) {
    const slidePath = rels.get(id);
    if (!slidePath || !availableSlidePaths.has(slidePath)) return null;
    ordered.push(slidePath);
  }
  return ordered.length > 0 ? ordered : null;
}

async function readPptxSlideNotesText(
  zip: ZipLike,
  slidePath: string,
  parser: Awaited<ReturnType<typeof createXmlParser>>,
): Promise<string> {
  const relsXml = await readZipText(zip, zipRelsPathForPart(slidePath));
  if (!relsXml) return "";
  const rels = parseRelationships(relsXml, parser, zipDirName(slidePath));
  const notesPaths = sortOfficePartPaths(
    Array.from(rels.values()).filter((path) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(path)),
  );
  const chunks: string[] = [];
  for (const notesPath of notesPaths) {
    const xml = await readZipText(zip, notesPath);
    if (!xml) continue;
    const text = parsePptxSlide(xml, parser).trim();
    if (text) chunks.push(text);
  }
  return chunks.join("\n");
}

async function parsePptx(buffer: Buffer): Promise<ParsedFileContent> {
  if (buffer.length === 0) throw new Error("pptx 文件为空");
  if (!isZipBuffer(buffer)) throw new Error("不是有效的 pptx zip 包");

  const [{ default: JSZip }, parser] = await Promise.all([
    import("jszip"),
    createXmlParser(),
  ]);
  const zip = await JSZip.loadAsync(buffer);
  const fallbackSlidePaths = sortPptxSlidePaths(
    Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path)),
  );
  const availableSlidePaths = new Set(fallbackSlidePaths);
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("text");
  const presentationRelsXml = await zip.file("ppt/_rels/presentation.xml.rels")?.async("text");
  const slidePaths =
    presentationXml && presentationRelsXml
      ? parsePptxPresentationOrder(presentationXml, presentationRelsXml, parser, availableSlidePaths) ?? fallbackSlidePaths
      : fallbackSlidePaths;
  if (slidePaths.length === 0) throw new Error("缺少有效幻灯片");

  const slideOutputs: string[] = [];
  for (let index = 0; index < slidePaths.length; index += 1) {
    const slidePath = slidePaths[index];
    if (!slidePath) continue;
    const slideXml = await zip.file(slidePath)?.async("text");
    if (!slideXml) continue;
    const body = parsePptxSlide(slideXml, parser);
    const notes = await readPptxSlideNotesText(zip, slidePath, parser);
    slideOutputs.push([`# Slide ${index + 1}`, body, notes].filter(Boolean).join("\n"));
  }
  if (slideOutputs.length === 0) {
    throw new Error("缺少可读幻灯片内容");
  }

  return { text: slideOutputs.join("\n\n"), pages: slidePaths.length };
}

async function parseExcelBuffer(buffer: Buffer, ext: string, mimeType: string): Promise<ParsedFileContent> {
  if (isCsvFile(ext, mimeType)) return { text: decodeTextBuffer(buffer), pages: 1 };

  const isXlsx =
    ext === "xlsx" || mimeType.toLowerCase() === XLSX_MIME || /spreadsheetml\.sheet/i.test(mimeType);
  if (isXlsx) return parseXlsx(buffer);

  if (looksLikeText(buffer)) return { text: decodeTextBuffer(buffer), pages: 1 };
  throw new UnsupportedParseFileError(
    "[Unsupported] 旧版 .xls 二进制格式暂不支持解析，请另存为 .xlsx 或 .csv 后上传。",
  );
}

async function parsePowerPointBuffer(buffer: Buffer, ext: string): Promise<ParsedFileContent> {
  if (isZipBuffer(buffer) || ext === "pptx") return parsePptx(buffer);
  throw new UnsupportedParseFileError(
    "[Unsupported] 旧版 .ppt 二进制格式暂不支持解析，请另存为 .pptx 后上传。",
  );
}

function parseErrorText(kind: "PDF" | "DOCX" | "Excel" | "PPT", error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `[Error] Failed to parse ${kind} file: ${message}`;
}

function parseFailure(kind: "PDF" | "DOCX" | "Excel" | "PPT" | "text", error: unknown): ParseFileBufferFailure {
  if (error instanceof UnsupportedParseFileError) {
    return {
      ok: false,
      text: "",
      error: error.message,
      failureKind: "unsupported",
      metadata: { pages: null, wordCount: 0, title: null, indexable: false },
    };
  }
  const message =
    kind === "text"
      ? `[Error] Failed to parse text file: ${error instanceof Error ? error.message : String(error)}`
      : parseErrorText(kind, error);
  return {
    ok: false,
    text: "",
    error: message,
    failureKind: "error",
    metadata: { pages: null, wordCount: 0, title: null, indexable: false },
  };
}

function stripPdfPaginationNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function successResult(text: string, pages: number | null, title: string | null, indexable = true): ParseFileBufferResult {
  const wordCount = text.replace(/\s+/g, "").length;
  return {
    ok: true,
    text,
    metadata: { pages, wordCount, title, indexable },
  };
}

function toParseFileToolResult(result: ParseFileBufferOutput): ParseFileToolResult {
  if (!result.ok) {
    return {
      text: result.error,
      metadata: { pages: null, wordCount: 0, title: null },
    };
  }
  return {
    text: result.text,
    metadata: {
      pages: result.metadata.pages,
      wordCount: result.metadata.wordCount,
      title: result.metadata.title,
    },
  };
}

export async function parseFileBuffer({
  buffer,
  filename,
  mimeType,
}: ParseFileBufferInput): Promise<ParseFileBufferOutput> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  let text = "";
  let pages: number | null = null;
  let title: string | null = null;

  if (ext === "pdf" || mimeType === "application/pdf") {
    try {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const textResult = await parser.getText();
        text = stripPdfPaginationNoise(textResult.text);
        pages = textResult.total;
        const infoResult = await parser.getInfo();
        title = infoResult.info?.Title ?? null;
      } finally {
        await parser.destroy();
      }
      return successResult(text, pages, title, text.trim().length > 0);
    } catch (error) {
      return parseFailure("PDF", error);
    }
  } else if (
    ext === "docx" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      const auxiliaryText = await extractDocxAuxiliaryText(buffer);
      text = [result.value, auxiliaryText].filter((part) => part.trim().length > 0).join("\n\n");
    } catch (error) {
      return parseFailure("DOCX", error);
    }
  } else if (isExcelFile(ext, mimeType)) {
    try {
      const result = await parseExcelBuffer(buffer, ext, mimeType);
      text = result.text;
      pages = result.pages;
      return successResult(text, pages, title, result.indexable ?? true);
    } catch (error) {
      return parseFailure("Excel", error);
    }
  } else if (isPowerPointFile(ext, mimeType)) {
    try {
      const result = await parsePowerPointBuffer(buffer, ext);
      text = result.text;
      pages = result.pages;
      return successResult(text, pages, title, result.indexable ?? true);
    } catch (error) {
      return parseFailure("PPT", error);
    }
  } else {
    try {
      text = decodeTextBuffer(buffer);
    } catch (error) {
      return parseFailure("text", error);
    }
  }

  return successResult(text, pages, title);
}

/**
 * parseFile tool — extracts plain text from uploaded files.
 * Supports PDF, DOCX, XLSX, CSV, PPTX, TXT, and MD formats.
 *
 * Accepts EITHER a file path (workspace-relative) OR base64-encoded
 * content. When `filePath` is provided it takes precedence; otherwise
 * `content` (base64) is used.
 */
export const parseFileTool = createTool({
  id: "parseFile",
  description:
    "解析文件内容。支持 PDF、DOCX、XLSX、CSV、PPTX、TXT、MD 格式。" +
    "可以传入 filePath（workspace 中的文件路径）、fileId（上传文件的内部 id）或 content（base64 编码内容）。" +
    "优先级 filePath > content > fileId。返回提取的纯文本和元数据。",
  inputSchema: z.object({
    filePath: z
      .string()
      .nullable()
      .optional()
      .describe("文件在 workspace 中的绝对路径（优先使用）"),
    fileId: z
      .string()
      .nullable()
      .optional()
      .describe("上传文件的内部 fileId（web 脱敏路径时使用，由安全 resolver 还原真实路径）"),
    content: z
      .string()
      .nullable()
      .optional()
      .describe("文件内容的 base64 编码（filePath 不存在时使用）"),
    filename: z.string().optional().describe("文件名（含扩展名）；传 fileId 时可省略，由 resolver 提供"),
    mimeType: z.string().optional().describe("MIME 类型；传 fileId 时可省略，由 resolver 提供"),
  }),
  outputSchema: z.object({
    text: z.string().describe("提取的纯文本内容"),
    metadata: z.object({
      pages: z.number().nullable(),
      wordCount: z.number(),
      title: z.string().nullable(),
    }),
  }),
  execute: async (input, context) => {
    const { filePath, content, fileId } = input;
    let { filename, mimeType } = input;

    // 大 PDF/DOCX 解析(parser.getText() / mammoth.extractRawText())可能静默
    // 10-30s+,在慢环境下可能逼近 agent 90s idle 看门狗;心跳期间往主流注入瞬时 chunk 清零看
    // 门狗,避免"正在解析大文件却被空闲超时误杀"(writer 缺失/写失败均静默)。
    const stopHeartbeat = startToolHeartbeat(context, { tool: "parseFile" });
    try {
      let buffer: Buffer;
      if (filePath) {
        // Read from filesystem
        buffer = await readFile(filePath);
      } else if (content !== undefined && content !== null) {
        buffer = Buffer.from(content, "base64");
      } else if (fileId) {
        // CC 脱敏:web 模式模型只拿到 fileId,这里用安全 resolver(限定 ./uploads 根目录、
        // realpath 校验防越权)还原真实路径;filename/mimeType 以 resolver 为准。
        const [resolved] = await resolveFileIds([fileId]);
        if (!resolved) {
          return {
            text: `[Error] 无法解析 fileId: ${fileId}（上传文件不存在或不可访问）`,
            metadata: { pages: null, wordCount: 0, title: null },
          };
        }
        buffer = await readFile(resolved.filePath);
        filename = filename ?? resolved.filename;
        mimeType = mimeType ?? resolved.mimeType;
      } else {
        return {
          text: "[Error] Either filePath, content or fileId must be provided",
          metadata: { pages: null, wordCount: 0, title: null },
        };
      }

      if (!filename || !mimeType) {
        return {
          text: "[Error] filename 与 mimeType 不能为空（传 filePath/content 时必填）",
          metadata: { pages: null, wordCount: 0, title: null },
        };
      }

      return toParseFileToolResult(await parseFileBuffer({ buffer, filename, mimeType }));
    } finally {
      stopHeartbeat();
    }
  },
});
