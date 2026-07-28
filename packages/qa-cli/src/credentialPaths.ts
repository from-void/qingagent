/**
 * qa CLI 侧的 credential-paths 校验。与 @qingagent/core 的 skills/credentialPaths.ts
 * 同一口径,但 CLI 不知道目标机器的 HOME,所以只按"~/ 之后的相对形态"判定——
 * 这正是服务端展开 HOME 后会得到的形状,结论一致。
 */

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** HOME 下永不放行的相对路径(浏览器数据 / 系统钥匙串)。 */
const NEVER_ALLOWED_RELATIVE_PATHS = [
  ".local/share/keyrings",
  ".local/share/kwalletd",
  ".config/google-chrome",
  ".config/chromium",
  ".config/microsoft-edge",
  ".config/BraveSoftware",
  ".mozilla",
  ".config/mozilla",
  ".var/app",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Firefox",
  "Library/Safari",
  "Library/Containers/com.apple.Safari",
  "Library/Group Containers/group.com.apple.Safari",
  "Library/Cookies",
  "Library/Keychains",
];

const NEVER_ALLOWED_SEGMENTS = new Set([
  "keychains",
  "keychain",
  "keyrings",
  "kwalletd",
  "google-chrome",
  "chromium",
  "microsoft-edge",
  "bravesoftware",
  "firefox",
  "cookies",
]);

function segmentsOf(value: string): string[] {
  return value.split("/").filter((part) => part.length > 0);
}

function isPrefixOf(shorter: string[], longer: string[]): boolean {
  return shorter.length <= longer.length && shorter.every((part, i) => part === longer[i]);
}

/** 合法返回 null;非法返回中文原因。 */
export function credentialPathError(declared: string): string | null {
  const raw = declared.trim();
  if (!raw) return "凭证路径不能为空";
  if (CONTROL_CHARACTER.test(raw)) return "凭证路径不能包含控制字符";
  if (raw.includes("\\")) return "凭证路径只能用 / 分隔";
  if (raw === "~" || raw === "~/") return "凭证路径不能是整个用户目录";
  if (!raw.startsWith("~/")) return "凭证路径必须以 ~/ 开头";

  const parts = segmentsOf(raw.slice(2));
  if (parts.length === 0) return "凭证路径不能是整个用户目录";
  if (parts.some((part) => part === "..")) return "凭证路径不能包含 .. ";
  if (parts.some((part) => part === ".")) return "凭证路径不能包含 . ";
  if (parts.some((part) => NEVER_ALLOWED_SEGMENTS.has(part.toLowerCase()))) {
    return "浏览器数据和系统钥匙串不可共享";
  }
  for (const blocked of NEVER_ALLOWED_RELATIVE_PATHS) {
    const blockedParts = segmentsOf(blocked);
    if (isPrefixOf(blockedParts, parts) || isPrefixOf(parts, blockedParts)) {
      return "浏览器数据和系统钥匙串不可共享";
    }
  }
  return null;
}

/** 从 SKILL.md 里取出 credential-paths 列表(行内数组与多行列表都支持)。 */
export function readCredentialPathsFromFrontmatter(source: string): string[] {
  const match = source
    .replace(/^\uFEFF/, "")
    .match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return [];
  const lines = match[1]!.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const pair = lines[index]!.match(/^credential-paths:[ \t]*(.*?)[ \t]*$/);
    if (!pair) continue;
    const inline = pair[1]!.trim();
    if (inline.startsWith("[") && inline.endsWith("]")) {
      return inline
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item.trim()))
        .filter((item) => item.length > 0);
    }
    if (inline) return [unquote(inline)];
    const items: string[] = [];
    while (index + 1 < lines.length) {
      const item = lines[index + 1]!.match(/^[ \t]+-[ \t]*(.+?)[ \t]*$/);
      if (!item) break;
      index += 1;
      const value = unquote(item[1]!);
      if (value) items.push(value);
    }
    return items;
  }
  return [];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}
