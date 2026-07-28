import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * 技能 frontmatter `credential-paths` 的唯一校验/规范化口径。
 *
 * 语义:技能声明「我需要和终端共享哪个凭证目录」,用户一次授权后,沙箱就把该路径
 * 从读墙里放出来并给写权限,于是 CLI 在青简里的登录态与在终端里完全是同一份。
 *
 * 硬边界(与授权无关,永不放行):浏览器数据目录与系统钥匙串/密钥环。这类目录一旦
 * 放行等于把用户全部网站登录态交出去,不属于"某个 CLI 的凭证"。
 */

/** HOME 下永不放行的相对路径(浏览器数据 / 系统钥匙串)。 */
const NEVER_ALLOWED_RELATIVE_PATHS = [
  // Linux:密钥环 / 钱包
  ".local/share/keyrings",
  ".local/share/kwalletd",
  // Linux:浏览器 profile
  ".config/google-chrome",
  ".config/chromium",
  ".config/microsoft-edge",
  ".config/BraveSoftware",
  ".mozilla",
  ".config/mozilla",
  ".var/app",
  // macOS:浏览器 profile / Cookie / 钥匙串
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
] as const;

/** 路径任一段命中即永不放行(兜住上面清单没枚举到的同类目录)。 */
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

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export type CredentialPathType = "directory" | "file";

export interface CredentialPathDeclaration {
  /** frontmatter 里的原始写法,回显给用户看。 */
  declared: string;
  /** 展开 HOME 后的绝对路径,授权与策略都以它为准。 */
  path: string;
}

export type CredentialPathCheck =
  | { ok: true; value: CredentialPathDeclaration }
  | { ok: false; reason: string };

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function neverAllowedAbsolutePaths(home: string): string[] {
  return [
    ...NEVER_ALLOWED_RELATIVE_PATHS.map((item) => resolve(home, ...item.split("/"))),
    // 系统级钥匙串不在 HOME 下,但同样永不放行。
    "/Library/Keychains",
  ];
}

/** 该路径是否属于"浏览器数据 / 系统钥匙串"类——授权也不放行、YOLO 档也不豁免。 */
export function isNeverAllowedCredentialPath(absolutePath: string, home: string): boolean {
  const normalized = resolve(absolutePath);
  const segments = normalized.split(sep).filter(Boolean).map((part) => part.toLowerCase());
  if (segments.some((part) => NEVER_ALLOWED_SEGMENTS.has(part))) return true;
  return neverAllowedAbsolutePaths(home).some(
    (blocked) => isInside(normalized, blocked) || isInside(blocked, normalized),
  );
}

/**
 * 校验并规范化单条声明。返回 reason 时是给技能作者/校验器看的中文原因。
 */
export function checkCredentialPath(declared: string, home: string): CredentialPathCheck {
  const raw = declared.trim();
  if (!raw) return { ok: false, reason: "凭证路径不能为空" };
  if (CONTROL_CHARACTER.test(raw)) return { ok: false, reason: "凭证路径不能包含控制字符" };
  if (raw.includes("\\")) return { ok: false, reason: "凭证路径只能用 / 分隔" };
  if (raw.split("/").some((part) => part === "..")) {
    return { ok: false, reason: "凭证路径不能包含 .. " };
  }

  const homeRoot = resolve(home);
  let absolute: string;
  if (raw === "~" || raw === "~/") return { ok: false, reason: "凭证路径不能是整个用户目录" };
  if (raw.startsWith("~/")) absolute = resolve(homeRoot, raw.slice(2));
  else if (isAbsolute(raw)) absolute = resolve(raw);
  else return { ok: false, reason: "凭证路径必须以 ~/ 开头" };

  if (absolute === homeRoot) return { ok: false, reason: "凭证路径不能是整个用户目录" };
  if (!isInside(absolute, homeRoot)) return { ok: false, reason: "凭证路径必须在用户目录下" };
  if (isNeverAllowedCredentialPath(absolute, homeRoot)) {
    return { ok: false, reason: "浏览器数据和系统钥匙串不可共享" };
  }
  return { ok: true, value: { declared: raw, path: absolute } };
}

export interface CredentialPathsParseResult {
  paths: CredentialPathDeclaration[];
  errors: string[];
}

/** 批量校验 frontmatter 声明;非法条目只报错、不静默降级为放行。 */
export function parseCredentialPathDeclarations(
  declared: readonly string[],
  home: string,
): CredentialPathsParseResult {
  const paths: CredentialPathDeclaration[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const item of declared) {
    const checked = checkCredentialPath(item, home);
    if (!checked.ok) {
      errors.push(`${item.trim() || "(空)"}: ${checked.reason}`);
      continue;
    }
    if (seen.has(checked.value.path)) continue;
    seen.add(checked.value.path);
    paths.push(checked.value);
  }
  return { paths, errors };
}
