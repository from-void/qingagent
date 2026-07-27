import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { constants as fsConstants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { TextDecoder } from "node:util";
import { startToolHeartbeat } from "./toolHeartbeat.js";
import { statOpenedFileIdentity, verifyOpenedFilePath } from "./openedFilePath.js";
import {
  inferMimeTypeFromFilename,
  resolveFileIds,
} from "../session/uploadFileResolver.js";
import { loadPdfParseConstructor } from "@qingagent/doc-render/browser";
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
  signal?: AbortSignal;
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

type ParseFileToolMetadata = {
  pages: number | null;
  wordCount: number;
  title: string | null;
};

type ParseFileToolResult = {
  ok?: true;
  text: string;
  metadata: ParseFileToolMetadata;
} | {
  ok: false;
  error: string;
  errorCode: "FILE_ACCESS_DENIED" | "FILE_NOT_REGULAR" | "FILE_TOO_LARGE";
  text: string;
  metadata: ParseFileToolMetadata;
};

// Office Open XML 本质是 ZIP。这里的限额必须在 mammoth/JSZip 解压任何 entry 之前生效，
// 避免高压缩比内容把主进程堆内存打满。阈值覆盖正常办公文档，同时给 XML 膨胀留出余量。
const MAX_OFFICE_ZIP_ENTRIES = 10_000;
const MAX_OFFICE_ZIP_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_OFFICE_ZIP_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_OFFICE_ZIP_COMPRESSION_RATIO = 200;
// 64MiB 足以覆盖常见桌面文档素材，同时限制分块汇总缓冲区和后续解析的堆内存占用。
const MAX_DESKTOP_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DESKTOP_FILE_LABEL = "64MiB";

const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES = 46;

const FILE_ACCESS_DENIED_RESULT: ParseFileToolResult = {
  ok: false,
  error: "文件不可访问",
  errorCode: "FILE_ACCESS_DENIED",
  text: "[Error] 文件不可访问",
  metadata: { pages: null, wordCount: 0, title: null },
};

const FILE_NOT_REGULAR_RESULT: ParseFileToolResult = {
  ok: false,
  error: "不是常规文件",
  errorCode: "FILE_NOT_REGULAR",
  text: "[Error] 不是常规文件",
  metadata: { pages: null, wordCount: 0, title: null },
};

const FILE_TOO_LARGE_RESULT: ParseFileToolResult = {
  ok: false,
  error: `文件过大（上限 ${MAX_DESKTOP_FILE_LABEL}）`,
  errorCode: "FILE_TOO_LARGE",
  text: `[Error] 文件过大（上限 ${MAX_DESKTOP_FILE_LABEL}）`,
  metadata: { pages: null, wordCount: 0, title: null },
};

// 路径规则刻意保持短而明确：覆盖操作系统凭据区、常见 CLI 凭据和浏览器凭据库，
// 不扩展成用户可配置的授权目录/权限系统。
const SENSITIVE_DESKTOP_PATH_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.aws\/(sso|cli)\/cache(\/|$)/,
  /(^|\/)\.azure\/(accessTokens\.json|azureProfile\.json|msal_token_cache\.(json|bin))$/i,
  /(^|\/)\.config\/gcloud\/(credentials\.db|access_tokens\.db|application_default_credentials\.json)$/,
  /(^|\/)\.config\/gcloud\/legacy_credentials(\/|$)/,
  /(^|\/)\.config\/(gh\/hosts\.yml|glab-cli\/config\.yml)$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.password-store(\/|$)/,
  /(^|\/)\.local\/share\/keyrings(\/|$)/,
  /(^|\/)Library\/Keychains(\/|$)/i,
  /(^|\/)System\/Library\/Keychains(\/|$)/i,
  /(^|\/)AppData\/(Local|Roaming)\/Microsoft\/(Credentials|Protect)(\/|$)/i,
  /(^|\/)Library\/Application Support\/(Google\/Chrome|Chromium|BraveSoftware|Microsoft Edge)(\/|$)/i,
  /(^|\/)AppData\/(Local|Roaming)\/(Google\/Chrome|Chromium|BraveSoftware|Microsoft\/Edge)(\/|$)/i,
  /(^|\/)(\.mozilla|Library\/Application Support\/Firefox|AppData\/Roaming\/Mozilla\/Firefox)(\/|$)/i,
  /(^|\/)Library\/Safari(\/|$)/i,
  /^\/proc\/[^/]+\/(environ|cmdline)$/,
  /^\/etc\/(shadow|gshadow|sudoers|krb5\.keytab)(\/|$)/,
  /^\/etc\/ssl\/private(\/|$)/,
];

const SENSITIVE_DESKTOP_FILENAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".cred-key",
  ".cred-key.safe",
  "credentials.json",
  "login data",
  "logins.json",
  "key4.db",
  "cookies.sqlite",
]);

class UnsupportedParseFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedParseFileError";
  }
}

function isZipBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function officeZipSafetyError(message: string): Error {
  return new Error(`Office ZIP 安全校验失败：${message}`);
}

function findZipEndOfCentralDirectory(buffer: Buffer, signal?: AbortSignal): number {
  const firstCandidate = buffer.length - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES;
  const lastCandidate = Math.max(
    0,
    buffer.length - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES - ZIP_MAX_COMMENT_BYTES,
  );
  for (let offset = firstCandidate; offset >= lastCandidate; offset -= 1) {
    if ((firstCandidate - offset) % 1024 === 0) signal?.throwIfAborted();
    if (buffer.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + ZIP_END_OF_CENTRAL_DIRECTORY_BYTES + commentLength === buffer.length) {
      return offset;
    }
  }
  throw officeZipSafetyError("缺少有效的 ZIP 中央目录");
}

/** 只读 ZIP 中央目录元数据，不解压 entry。 */
function assertSafeOfficeZip(buffer: Buffer, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (!isZipBuffer(buffer) || buffer.length < ZIP_END_OF_CENTRAL_DIRECTORY_BYTES) {
    throw officeZipSafetyError("不是有效的 ZIP 文件");
  }

  const eocdOffset = findZipEndOfCentralDirectory(buffer, signal);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryBytes = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntries !== totalEntries) {
    throw officeZipSafetyError("不支持分卷 ZIP");
  }
  if (
    totalEntries === 0xffff ||
    centralDirectoryBytes === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    // 正常 Office 文档在上述限额下不需要 ZIP64；拒绝它可避免 64 位扩展字段绕过限额。
    throw officeZipSafetyError("不支持 ZIP64");
  }
  if (totalEntries > MAX_OFFICE_ZIP_ENTRIES) {
    throw officeZipSafetyError(`条目数超过上限 ${MAX_OFFICE_ZIP_ENTRIES}`);
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectoryBytes;
  if (
    centralDirectoryOffset > eocdOffset ||
    centralDirectoryEnd > eocdOffset ||
    centralDirectoryEnd > buffer.length
  ) {
    throw officeZipSafetyError("ZIP 中央目录范围无效");
  }

  let cursor = centralDirectoryOffset;
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    signal?.throwIfAborted();
    if (
      cursor + ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES > centralDirectoryEnd ||
      buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_ENTRY_SIGNATURE
    ) {
      throw officeZipSafetyError("ZIP 中央目录条目损坏");
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const compressedBytes = buffer.readUInt32LE(cursor + 20);
    const uncompressedBytes = buffer.readUInt32LE(cursor + 24);
    const filenameBytes = buffer.readUInt16LE(cursor + 28);
    const extraBytes = buffer.readUInt16LE(cursor + 30);
    const commentBytes = buffer.readUInt16LE(cursor + 32);
    const entryBytes = ZIP_CENTRAL_DIRECTORY_ENTRY_BYTES + filenameBytes + extraBytes + commentBytes;

    if ((flags & 0x0001) !== 0) {
      throw officeZipSafetyError("不支持加密 ZIP 条目");
    }
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff) {
      throw officeZipSafetyError("不支持 ZIP64 条目");
    }
    if (uncompressedBytes > MAX_OFFICE_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
      throw officeZipSafetyError(
        `单个条目解压后超过 ${MAX_OFFICE_ZIP_ENTRY_UNCOMPRESSED_BYTES} 字节`,
      );
    }
    if (
      uncompressedBytes > 0 &&
      (compressedBytes === 0 || uncompressedBytes / compressedBytes > MAX_OFFICE_ZIP_COMPRESSION_RATIO)
    ) {
      throw officeZipSafetyError(`单个条目压缩比超过 ${MAX_OFFICE_ZIP_COMPRESSION_RATIO}:1`);
    }

    totalCompressedBytes += compressedBytes;
    totalUncompressedBytes += uncompressedBytes;
    if (totalUncompressedBytes > MAX_OFFICE_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw officeZipSafetyError(
        `总解压量超过 ${MAX_OFFICE_ZIP_TOTAL_UNCOMPRESSED_BYTES} 字节`,
      );
    }
    cursor += entryBytes;
    if (cursor > centralDirectoryEnd) {
      throw officeZipSafetyError("ZIP 中央目录条目越界");
    }
  }

  if (cursor !== centralDirectoryEnd) {
    throw officeZipSafetyError("ZIP 中央目录长度不一致");
  }
  if (
    totalUncompressedBytes > 0 &&
    (totalCompressedBytes === 0 ||
      totalUncompressedBytes / totalCompressedBytes > MAX_OFFICE_ZIP_COMPRESSION_RATIO)
  ) {
    throw officeZipSafetyError(`总压缩比超过 ${MAX_OFFICE_ZIP_COMPRESSION_RATIO}:1`);
  }
}

function normalizeDesktopPathForPolicy(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return (normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized).toLowerCase();
}

function isSensitiveDesktopFilePath(filePath: string): boolean {
  const normalized = normalizeDesktopPathForPolicy(filePath);
  const basename = normalized.split("/").pop()?.toLowerCase() ?? "";
  if (basename === ".env") return true;
  if (
    basename.startsWith(".env.") &&
    ![".example", ".sample", ".template", ".dist"].some((suffix) => basename.endsWith(suffix))
  ) {
    return true;
  }
  if (SENSITIVE_DESKTOP_FILENAMES.has(basename)) return true;
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/i.test(basename) && !basename.endsWith(".pub")) {
    return true;
  }
  if (/\.(p12|pfx)$/i.test(basename) || /(^|[._-])private[._-]?key(\.|$)/i.test(basename)) {
    return true;
  }
  return SENSITIVE_DESKTOP_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

type DesktopFileReadResult =
  | { status: "ok"; buffer: Buffer; canonicalPath: string }
  | { status: "denied" }
  | { status: "not_regular" }
  | { status: "too_large" };

async function readDesktopFilePath(
  filePath: string,
  signal?: AbortSignal,
): Promise<DesktopFileReadResult> {
  signal?.throwIfAborted();
  if (isSensitiveDesktopFilePath(filePath)) return { status: "denied" };
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(filePath);
    signal?.throwIfAborted();
  } catch {
    // 保留正常素材原有的 ENOENT/EACCES 语义；后续 open 会抛出对应错误。
    canonicalPath = filePath;
  }
  if (isSensitiveDesktopFilePath(canonicalPath)) return { status: "denied" };
  signal?.throwIfAborted();
  const expectedIdentity = await statOpenedFileIdentity(canonicalPath);
  signal?.throwIfAborted();

  // Windows 没有 O_NOFOLLOW，且 Node FileHandle 无安全的最终路径反查 API；
  // 打开后 verifyOpenedFilePath 会明确 fail-closed，不再接受 reparse point 竞态残留。
  const noFollow =
    process.platform === "win32"
      ? 0
      : typeof fsConstants.O_NOFOLLOW === "number"
        ? fsConstants.O_NOFOLLOW
        : 0;
  const nonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
  // O_NOFOLLOW 只约束最终组件；父目录替换窗口由打开后的 fd 实际路径复核封住。
  const fileHandle = await open(canonicalPath, fsConstants.O_RDONLY | noFollow | nonBlock);
  try {
    signal?.throwIfAborted();
    try {
      canonicalPath = await verifyOpenedFilePath(fileHandle, {
        expectedPath: canonicalPath,
        expectedIdentity,
        validatePath: (actualPath) => !isSensitiveDesktopFilePath(actualPath),
      });
    } catch {
      return { status: "denied" };
    }
    signal?.throwIfAborted();
    const stats = await fileHandle.stat();
    if (!stats.isFile()) return { status: "not_regular" };
    // realpath 无法识别硬链接。正常用户素材极少带多个硬链接；宁可拒绝可疑文件，
    // 也不允许攻击者把敏感文件硬链接成无害名称绕过路径黑名单。
    if (stats.nlink > 1) return { status: "denied" };
    if (stats.size > MAX_DESKTOP_FILE_BYTES) return { status: "too_large" };

    // fileHandle.read 本身没有 signal 参数；每个 64KiB 分块前后检查父 signal，取消后不再继续读。
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_DESKTOP_FILE_BYTES) {
      signal?.throwIfAborted();
      // 最多多读 1 字节用于区分“恰好到上限”和“超过上限”，避免竞态增大的文件被整体读入。
      const remainingProbeBytes = MAX_DESKTOP_FILE_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remainingProbeBytes));
      const { bytesRead } = await fileHandle.read(chunk, 0, chunk.length, null);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_DESKTOP_FILE_BYTES) return { status: "too_large" };
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
    }

    const statsAfterRead = await fileHandle.stat();
    if (statsAfterRead.size > MAX_DESKTOP_FILE_BYTES) return { status: "too_large" };
    return { status: "ok", buffer: Buffer.concat(chunks, totalBytes), canonicalPath };
  } finally {
    await fileHandle.close();
  }
}

function isCsvFile(ext: string): boolean {
  return ext === "csv";
}

function isExcelFile(ext: string): boolean {
  return ext === "xlsx" || ext === "xls" || isCsvFile(ext);
}

function isPowerPointFile(ext: string): boolean {
  return ext === "pptx" || ext === "ppt";
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

type ZipEntryStream = {
  on(event: "data", callback: (chunk: Uint8Array) => void): ZipEntryStream;
  on(event: "end", callback: () => void): ZipEntryStream;
  on(event: "error", callback: (error: Error) => void): ZipEntryStream;
  pause(): ZipEntryStream;
  resume(): ZipEntryStream;
};

type ZipEntryLike = {
  dir: boolean;
  async(type: "text"): Promise<string>;
  internalStream(type: "uint8array"): ZipEntryStream;
};

type ZipLike = {
  files: Record<string, ZipEntryLike>;
  file(path: string): ZipEntryLike | null;
};

async function readZipText(
  zip: ZipLike,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  const text = (await zip.file(path)?.async("text")) ?? null;
  signal?.throwIfAborted();
  return text;
}

/**
 * 逐条目实际解压并按输出 chunk 计数，不能信任 ZIP 中央目录自报的 uncompressed size。
 * internalStream 不聚合完整 entry，超过限额时 pause 可立即停止继续产出。
 */
async function assertSafeOfficeZipInflation(
  zip: ZipLike,
  signal?: AbortSignal,
): Promise<void> {
  let totalUncompressedBytes = 0;

  for (const entry of Object.values(zip.files)) {
    signal?.throwIfAborted();
    if (entry.dir) continue;

    await new Promise<void>((resolve, reject) => {
      const stream = entry.internalStream("uint8array");
      let entryUncompressedBytes = 0;
      let settled = false;

      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        stream.pause();
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(signal?.reason ?? new DOMException("文件解压已取消", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      stream
        .on("data", (chunk) => {
          if (settled) return;
          if (signal?.aborted) {
            onAbort();
            return;
          }
          entryUncompressedBytes += chunk.byteLength;
          totalUncompressedBytes += chunk.byteLength;

          if (entryUncompressedBytes > MAX_OFFICE_ZIP_ENTRY_UNCOMPRESSED_BYTES) {
            fail(
              officeZipSafetyError(
                `单个条目实际解压后超过 ${MAX_OFFICE_ZIP_ENTRY_UNCOMPRESSED_BYTES} 字节`,
              ),
            );
          } else if (totalUncompressedBytes > MAX_OFFICE_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
            fail(
              officeZipSafetyError(
                `实际总解压量超过 ${MAX_OFFICE_ZIP_TOTAL_UNCOMPRESSED_BYTES} 字节`,
              ),
            );
          }
        })
        .on("error", (error) => {
          fail(officeZipSafetyError(`条目实际解压失败：${error.message}`));
        })
        .on("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        })
        .resume();
    });
  }
}

export async function loadSafeOfficeZip(
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<ZipLike> {
  // 中央目录预检用于快速失败；真正的解压量保护由下方实际流式计数提供。
  assertSafeOfficeZip(buffer, signal);
  signal?.throwIfAborted();
  const { default: JSZip } = await import("jszip");
  signal?.throwIfAborted();
  // JSZip 运行时提供 internalStream，但公开类型只声明了 async/nodeStream。
  // JSZip.loadAsync 本身没有 AbortSignal 接口；调用返回后立即检查。真正的 entry 解压流
  // 在 assertSafeOfficeZipInflation 内逐块检查 signal 并 pause。
  const zip = (await JSZip.loadAsync(buffer)) as unknown as ZipLike;
  signal?.throwIfAborted();
  await assertSafeOfficeZipInflation(zip, signal);
  signal?.throwIfAborted();
  return zip;
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
  signal?: AbortSignal,
): string {
  signal?.throwIfAborted();
  const doc = parser.parseFromString(xml, "application/xml");
  const lines: string[] = [];

  for (const row of getElementsByLocalName(doc, "row")) {
    signal?.throwIfAborted();
    if (isHiddenXlsxRow(row)) continue;
    const values: string[] = [];
    for (const cell of getChildElementsByLocalName(row, "c")) {
      signal?.throwIfAborted();
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

async function parseXlsx(
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<ParsedFileContent> {
  signal?.throwIfAborted();
  if (buffer.length === 0) throw new Error("xlsx 文件为空");
  if (!isZipBuffer(buffer)) throw new Error("不是有效的 xlsx zip 包");

  const [zip, parser] = await Promise.all([
    loadSafeOfficeZip(buffer, signal),
    createXmlParser(),
  ]);
  signal?.throwIfAborted();
  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) throw new Error("缺少 xl/workbook.xml");

  const workbookXml = await readZipText(zip, "xl/workbook.xml", signal);
  if (workbookXml === null) throw new Error("缺少 xl/workbook.xml");
  const workbookDoc = parser.parseFromString(workbookXml, "application/xml");
  signal?.throwIfAborted();
  const date1904 = workbookUses1904Dates(workbookDoc);
  const relsXml = await readZipText(zip, "xl/_rels/workbook.xml.rels", signal);
  const relationships = relsXml ? parseWorkbookRelationships(relsXml, parser) : new Map<string, string>();
  const sharedStringsXml = await readZipText(zip, "xl/sharedStrings.xml", signal);
  const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml, parser) : [];
  const stylesXml = await readZipText(zip, "xl/styles.xml", signal);
  const styles = stylesXml ? parseXlsxStyles(stylesXml, parser) : [];

  const sheetOutputs: string[] = [];
  const sheets = getElementsByLocalName(workbookDoc, "sheet");
  if (sheets.length === 0) throw new Error("缺少有效工作表");
  for (let index = 0; index < sheets.length; index += 1) {
    signal?.throwIfAborted();
    const sheet = sheets[index];
    if (!sheet) continue;
    if (isHiddenXlsxSheet(sheet)) continue;
    const name = sheet.getAttribute("name") || `Sheet${index + 1}`;
    const relationshipId = sheet.getAttribute("r:id") || sheet.getAttribute("id");
    const sheetPath =
      (relationshipId ? relationships.get(relationshipId) : undefined) ??
      `xl/worksheets/sheet${index + 1}.xml`;
    const sheetXml = await readZipText(zip, sheetPath, signal);
    if (!sheetXml) continue;

    const body = parseXlsxSheet(sheetXml, parser, sharedStrings, styles, date1904, signal);
    sheetOutputs.push([`# Sheet: ${name}`, body].filter(Boolean).join("\n"));
  }
  if (sheetOutputs.length === 0) {
    throw new Error("缺少可读工作表内容");
  }

  return { text: sheetOutputs.join("\n\n"), pages: sheetOutputs.length };
}

function parseWordTextXml(
  xml: string,
  parser: Awaited<ReturnType<typeof createXmlParser>>,
  signal?: AbortSignal,
): string {
  signal?.throwIfAborted();
  const doc = parser.parseFromString(xml, "application/xml");
  const paragraphs: string[] = [];
  for (const paragraph of getElementsByLocalName(doc, "p")) {
    signal?.throwIfAborted();
    const text = collectDescendantText(paragraph, "t").trim();
    if (text) paragraphs.push(text);
  }
  if (paragraphs.length > 0) return paragraphs.join("\n");
  const textRuns: string[] = [];
  for (const node of getElementsByLocalName(doc, "t")) {
    signal?.throwIfAborted();
    const text = (node.textContent ?? "").trim();
    if (text) textRuns.push(text);
  }
  return textRuns.join("\n");
}

async function extractDocxAuxiliaryText(
  zip: ZipLike,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const parser = await createXmlParser();
  signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    const xml = await readZipText(zip, path, signal);
    if (!xml) continue;
    const text = parseWordTextXml(xml, parser, signal).trim();
    signal?.throwIfAborted();
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
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const relsXml = await readZipText(zip, zipRelsPathForPart(slidePath), signal);
  if (!relsXml) return "";
  const rels = parseRelationships(relsXml, parser, zipDirName(slidePath));
  const notesPaths = sortOfficePartPaths(
    Array.from(rels.values()).filter((path) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(path)),
  );
  const chunks: string[] = [];
  for (const notesPath of notesPaths) {
    signal?.throwIfAborted();
    const xml = await readZipText(zip, notesPath, signal);
    if (!xml) continue;
    const text = parsePptxSlide(xml, parser).trim();
    if (text) chunks.push(text);
  }
  return chunks.join("\n");
}

async function parsePptx(
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<ParsedFileContent> {
  signal?.throwIfAborted();
  if (buffer.length === 0) throw new Error("pptx 文件为空");
  if (!isZipBuffer(buffer)) throw new Error("不是有效的 pptx zip 包");

  const [zip, parser] = await Promise.all([
    loadSafeOfficeZip(buffer, signal),
    createXmlParser(),
  ]);
  signal?.throwIfAborted();
  const fallbackSlidePaths = sortPptxSlidePaths(
    Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path)),
  );
  const availableSlidePaths = new Set(fallbackSlidePaths);
  const presentationXml = await readZipText(zip, "ppt/presentation.xml", signal);
  const presentationRelsXml = await readZipText(
    zip,
    "ppt/_rels/presentation.xml.rels",
    signal,
  );
  const slidePaths =
    presentationXml && presentationRelsXml
      ? parsePptxPresentationOrder(presentationXml, presentationRelsXml, parser, availableSlidePaths) ?? fallbackSlidePaths
      : fallbackSlidePaths;
  if (slidePaths.length === 0) throw new Error("缺少有效幻灯片");

  const slideOutputs: string[] = [];
  for (let index = 0; index < slidePaths.length; index += 1) {
    signal?.throwIfAborted();
    const slidePath = slidePaths[index];
    if (!slidePath) continue;
    const slideXml = await readZipText(zip, slidePath, signal);
    if (!slideXml) continue;
    const body = parsePptxSlide(slideXml, parser);
    signal?.throwIfAborted();
    const notes = await readPptxSlideNotesText(zip, slidePath, parser, signal);
    slideOutputs.push([`# Slide ${index + 1}`, body, notes].filter(Boolean).join("\n"));
  }
  if (slideOutputs.length === 0) {
    throw new Error("缺少可读幻灯片内容");
  }

  return { text: slideOutputs.join("\n\n"), pages: slidePaths.length };
}

async function parseExcelBuffer(
  buffer: Buffer,
  ext: string,
  signal?: AbortSignal,
): Promise<ParsedFileContent> {
  signal?.throwIfAborted();
  if (isCsvFile(ext)) return { text: decodeTextBuffer(buffer), pages: 1 };

  if (ext === "xlsx") return parseXlsx(buffer, signal);

  if (looksLikeText(buffer)) return { text: decodeTextBuffer(buffer), pages: 1 };
  throw new UnsupportedParseFileError(
    "[Unsupported] 旧版 .xls 二进制格式暂不支持解析，请另存为 .xlsx 或 .csv 后上传。",
  );
}

async function parsePowerPointBuffer(
  buffer: Buffer,
  ext: string,
  signal?: AbortSignal,
): Promise<ParsedFileContent> {
  signal?.throwIfAborted();
  if (isZipBuffer(buffer) || ext === "pptx") return parsePptx(buffer, signal);
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

function stripPdfPaginationNoise(text: string, signal?: AbortSignal): string {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    signal?.throwIfAborted();
    if (!/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/.test(line)) lines.push(line);
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function parsePdfBufferOnce(
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<ParseFileBufferResult> {
  signal?.throwIfAborted();
  // 用 interop 安全加载器(#11 桌面打包修复:CJS/ESM 互操作下 PDFParse 不是构造器),
  // 不要退回裸 `import("pdf-parse")`——否则桌面包里 PDFParse2 is not a constructor 复发
  const PDFParse = await loadPdfParseConstructor();
  signal?.throwIfAborted();
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let parsed: ParseFileBufferResult;
  try {
    // pdf-parse/pdf.js 的 CPU 解析目前没有 AbortSignal/terminate 接口；本轮在调用前后与
    // 自有逐行清洗循环检查。若需硬实时取消，后续必须迁入可 terminate 的 Worker。
    const textResult = await parser.getText();
    signal?.throwIfAborted();
    const text = stripPdfPaginationNoise(textResult.text, signal);
    const pages = textResult.total;
    const infoResult = await parser.getInfo();
    signal?.throwIfAborted();
    const title = infoResult.info?.Title ?? null;
    parsed = successResult(text, pages, title, text.trim().length > 0);
  } finally {
    await parser.destroy();
  }
  signal?.throwIfAborted();
  return parsed;
}

function shouldRetryEmptyPdfResult(result: ParseFileBufferResult): boolean {
  return result.ok && result.text.trim().length === 0 && (result.metadata.pages ?? 0) > 0;
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
  signal,
}: ParseFileBufferInput): Promise<ParseFileBufferOutput> {
  signal?.throwIfAborted();
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  let text = "";
  let pages: number | null = null;
  let title: string | null = null;

  // MIME 由调用方声明，只作为接口元数据保留；解析器选择必须由可信 filename 扩展名决定。
  if (ext === "pdf") {
    // #16 冷启动有界重试 + #11 interop 加载器(在 parsePdfBufferOnce 内)合并
    let emptyFallback: ParseFileBufferResult | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      signal?.throwIfAborted();
      try {
        const result = await parsePdfBufferOnce(buffer, signal);
        if (attempt === 1 && shouldRetryEmptyPdfResult(result)) {
          emptyFallback = result;
          continue;
        }
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        if (attempt === 1) continue;
      }
    }
    if (emptyFallback) return emptyFallback;
    return parseFailure("PDF", lastError);
  } else if (ext === "docx") {
    try {
      signal?.throwIfAborted();
      // mammoth 内部会再次解压；先用 JSZip 实际流式解压计数，确保自报尺寸无法绕过限额。
      const zip = await loadSafeOfficeZip(buffer, signal);
      signal?.throwIfAborted();
      const mammoth = await import("mammoth");
      signal?.throwIfAborted();
      // mammoth.extractRawText 内部再次解压/遍历且不接受 AbortSignal；自有 ZIP 预检、
      // 实际解压计数和辅助 XML 遍历均可取消，但 mammoth 这段 CPU 工作仍只能在 await 后响应。
      // 真正硬终止需迁入 Worker 并在 signal abort 时 terminate。
      const result = await mammoth.extractRawText({ buffer });
      signal?.throwIfAborted();
      const auxiliaryText = await extractDocxAuxiliaryText(zip, signal);
      signal?.throwIfAborted();
      text = [result.value, auxiliaryText].filter((part) => part.trim().length > 0).join("\n\n");
    } catch (error) {
      signal?.throwIfAborted();
      return parseFailure("DOCX", error);
    }
  } else if (isExcelFile(ext)) {
    try {
      const result = await parseExcelBuffer(buffer, ext, signal);
      text = result.text;
      pages = result.pages;
      return successResult(text, pages, title, result.indexable ?? true);
    } catch (error) {
      signal?.throwIfAborted();
      return parseFailure("Excel", error);
    }
  } else if (isPowerPointFile(ext)) {
    try {
      const result = await parsePowerPointBuffer(buffer, ext, signal);
      text = result.text;
      pages = result.pages;
      return successResult(text, pages, title, result.indexable ?? true);
    } catch (error) {
      signal?.throwIfAborted();
      return parseFailure("PPT", error);
    }
  } else {
    try {
      text = decodeTextBuffer(buffer);
    } catch (error) {
      return parseFailure("text", error);
    }
  }

  signal?.throwIfAborted();
  return successResult(text, pages, title);
}

/**
 * parseFile tool — extracts plain text from uploaded files.
 * Supports PDF, DOCX, XLSX, CSV, PPTX, TXT, and MD formats.
 *
 * Web 上传文件只接受 fileId；桌面版也可读取本地 filePath，内部调用可传 base64 content。
 */
export const parseFileTool = createTool({
  id: "parseFile",
  description:
    "解析文件内容。支持 PDF、DOCX、XLSX、CSV、PPTX、TXT、MD 格式。" +
    "Web 端只接受 fileId；桌面端可使用受敏感路径黑名单保护的 filePath，也可使用 fileId 或 content。" +
    "返回提取的纯文本和元数据。",
  inputSchema: z.object({
    filePath: z
      .string()
      .nullable()
      .optional()
      .describe("桌面版本地素材路径（Web 版不接受）"),
    fileId: z
      .string()
      .nullable()
      .optional()
      .describe("上传文件的内部 fileId（web 脱敏路径时使用，由安全 resolver 还原真实路径）"),
    content: z
      .string()
      .nullable()
      .optional()
      .describe("文件内容的 base64 编码（仅受信任的桌面内部调用）"),
    filename: z.string().optional().describe("文件名（含扩展名）；传 fileId 时可省略，由 resolver 提供"),
    mimeType: z.string().optional().describe("MIME 类型；传 fileId 时可省略，由 resolver 提供"),
  }),
  outputSchema: z.object({
    ok: z.boolean().optional(),
    error: z.string().optional(),
    errorCode: z.enum([
      "FILE_ACCESS_DENIED",
      "FILE_NOT_REGULAR",
      "FILE_TOO_LARGE",
    ]).optional(),
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
    const isDesktopRuntime = process.env.QINGAGENT_RUNTIME === "desktop";

    // 大 PDF/DOCX 解析(parser.getText() / mammoth.extractRawText())可能静默
    // 10-30s+,在慢环境下可能逼近 agent 90s idle 看门狗;心跳期间往主流注入瞬时 chunk 清零看
    // 门狗,避免"正在解析大文件却被空闲超时误杀"(writer 缺失/写失败均静默)。
    const stopHeartbeat = startToolHeartbeat(context, { tool: "parseFile" });
    try {
      let buffer: Buffer;
      if (!isDesktopRuntime) {
        // Web 模式不信任模型提供的宿主路径或内联内容，只走 uploads resolver 的 fileId 通道。
        // 即使同时注入 filePath/content，也完全忽略，避免优先级绕过。
        if (!fileId) return FILE_ACCESS_DENIED_RESULT;
        // CC 脱敏:web 模式模型只拿到 fileId,这里用安全 resolver(限定 ./uploads 根目录、
        // realpath 校验防越权)还原真实路径;filename/mimeType 以 resolver 为准。
        const [resolved] = await resolveFileIds([fileId]);
        if (!resolved) {
          return {
            text: `[Error] 无法解析 fileId: ${fileId}（上传文件不存在或不可访问）`,
            metadata: { pages: null, wordCount: 0, title: null },
          };
        }
        buffer = await readFile(resolved.filePath, { signal: context?.abortSignal });
        filename = resolved.filename;
        mimeType = resolved.mimeType;
      } else if (filePath) {
        const desktopFile = await readDesktopFilePath(filePath, context?.abortSignal);
        if (desktopFile.status === "denied") return FILE_ACCESS_DENIED_RESULT;
        if (desktopFile.status === "not_regular") return FILE_NOT_REGULAR_RESULT;
        if (desktopFile.status === "too_large") return FILE_TOO_LARGE_RESULT;
        buffer = desktopFile.buffer;
        // 桌面 filePath 来自模型，filename/mimeType 同样不可作为真实格式依据；
        // 用 realpath 后的 basename 固定解析扩展名，避免声明 MIME/文件名改变解析分支。
        filename = basename(desktopFile.canonicalPath);
      } else if (content !== undefined && content !== null) {
        buffer = Buffer.from(content, "base64");
      } else if (fileId) {
        const [resolved] = await resolveFileIds([fileId]);
        if (!resolved) {
          return {
            text: `[Error] 无法解析 fileId: ${fileId}（上传文件不存在或不可访问）`,
            metadata: { pages: null, wordCount: 0, title: null },
          };
        }
        buffer = await readFile(resolved.filePath, { signal: context?.abortSignal });
        filename = resolved.filename;
        mimeType = resolved.mimeType;
      } else {
        return {
          text: "[Error] Either filePath, content or fileId must be provided",
          metadata: { pages: null, wordCount: 0, title: null },
        };
      }

      if (filename && !mimeType) {
        mimeType = inferMimeTypeFromFilename(filename) ?? undefined;
      }
      if (!filename || !mimeType) {
        return {
          text: "[Error] filename 与 mimeType 不能为空（扩展名未知时需显式传入 mimeType）",
          metadata: { pages: null, wordCount: 0, title: null },
        };
      }

      return toParseFileToolResult(
        await parseFileBuffer({
          buffer,
          filename,
          mimeType,
          signal: context?.abortSignal,
        }),
      );
    } finally {
      stopHeartbeat();
    }
  },
});
