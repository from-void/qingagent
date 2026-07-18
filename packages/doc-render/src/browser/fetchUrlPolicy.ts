import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface FetchUrlValidationOptions {
  /** 仅放行字面 loopback 与 localhost；普通域名解析到 loopback 仍拒绝。 */
  allowLoopback?: boolean;
  /** 放行私网、链路本地与其他非公网地址，供部署者显式逃生。 */
  allowPrivate?: boolean;
}

type AddressScope = "public" | "loopback" | "private";

function ipv4Scope(address: string): AddressScope {
  const parts = address.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return "public";
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return "loopback";
  if (
    a === 10 ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 168)
  ) {
    return "private";
  }
  return "public";
}

function extractIPv4MappedIPv6(address: string): string | null {
  const normalized = address.toLowerCase();
  const mappedPrefixes = ["::ffff:", "0:0:0:0:0:ffff:"];
  const prefix = mappedPrefixes.find((candidate) => normalized.startsWith(candidate));
  if (!prefix) return null;

  const suffix = normalized.slice(prefix.length);
  if (isIP(suffix) === 4) return suffix;

  const hextets = suffix.split(":");
  if (hextets.length !== 2) return null;

  const high = Number.parseInt(hextets[0]!, 16);
  const low = Number.parseInt(hextets[1]!, 16);
  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }

  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function ipv6Scope(address: string): AddressScope {
  const normalized = address.toLowerCase();
  const mappedIPv4 = extractIPv4MappedIPv6(normalized);
  if (mappedIPv4 !== null) return ipv4Scope(mappedIPv4);
  if (normalized === "::1") return "loopback";
  if (normalized === "::") return "private";

  const firstHextetText = normalized.split(":", 1)[0];
  const firstHextet = Number.parseInt(firstHextetText || "0", 16);
  if (
    Number.isInteger(firstHextet) &&
    // fc00::/7（ULA）与 fe80::/10（link-local）。
    ((firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80)
  ) {
    return "private";
  }
  return "public";
}

function assertAllowedAddress(
  address: string,
  source: string,
  options: FetchUrlValidationOptions,
): void {
  const kind = isIP(address);
  const scope = kind === 4 ? ipv4Scope(address) : kind === 6 ? ipv6Scope(address) : "public";
  if (scope === "loopback" && !options.allowLoopback && !options.allowPrivate) {
    throw new Error(`Blocked loopback address for ${source}: ${address}`);
  }
  if (scope === "private" && !options.allowPrivate) {
    throw new Error(`Blocked private address for ${source}: ${address}`);
  }
}

/**
 * 校验一次 DNS/连接层已经解析出的地址。普通域名不能借 allowLoopback 解析到本机；
 * 只有字面 loopback/localhost，或显式 allowPrivate，才允许连接 loopback。
 */
export function assertFetchAddressAllowed(
  address: string,
  sourceHostname: string,
  options: FetchUrlValidationOptions = {},
): void {
  const hostname = sourceHostname.toLowerCase();
  const addressHostname =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const explicitlyLocal = hostname === "localhost" || isIP(addressHostname) !== 0;
  assertAllowedAddress(address, hostname, {
    ...options,
    allowLoopback: explicitlyLocal ? options.allowLoopback : options.allowPrivate,
  });
}

export function parseFetchUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }

  return parsed;
}

/**
 * 出站 URL 的公共 SSRF 校验。默认只允许公网；调用方可按明确业务策略放行 loopback/私网。
 * DNS 校验与实际 fetch 仍是两次解析，不能单独防御 DNS rebinding。
 */
export async function validateFetchUrl(
  rawUrl: string,
  options: FetchUrlValidationOptions = {},
): Promise<URL> {
  const parsed = parseFetchUrl(rawUrl);
  const hostname = parsed.hostname.toLowerCase();
  const addressHostname =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  if (hostname === "localhost") {
    assertFetchAddressAllowed("127.0.0.1", hostname, options);
    return parsed;
  }

  const ipKind = isIP(addressHostname);
  if (ipKind) {
    assertFetchAddressAllowed(addressHostname, hostname, options);
    return parsed;
  }

  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error(`Could not resolve hostname: ${hostname}`);
  }
  for (const record of records) {
    assertFetchAddressAllowed(record.address, hostname, options);
  }

  return parsed;
}
