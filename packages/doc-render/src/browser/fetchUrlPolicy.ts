import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

export interface FetchUrlValidationOptions {
  /** 仅放行字面 loopback 与 localhost；普通域名解析到 loopback 仍拒绝。 */
  allowLoopback?: boolean;
  /** 放行所有非 global-unicast 地址，供可信内网部署者显式逃生。 */
  allowPrivate?: boolean;
}

type AddressScope = "global-unicast" | "loopback" | "non-global-unicast";

export interface PinnedFetchUrl {
  url: URL;
  /** 已通过策略校验、后续连接必须使用的地址。 */
  address: string;
  family: 4 | 6;
}

type Ipv4Range = readonly [network: number, prefixBits: number];

/**
 * IANA IPv4 Special-Purpose Address Registry 的保守超集。策略是 allow-list：
 * 只有不落入任何特殊用途块的单播地址才算 global-unicast。
 */
const NON_GLOBAL_IPV4_RANGES: readonly Ipv4Range[] = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // RFC1918
  [0x64400000, 10], // shared address space
  [0x7f000000, 8], // loopback（单独分类）
  [0xa9fe0000, 16], // link-local / metadata
  [0xac100000, 12], // RFC1918
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // TEST-NET-1
  [0xc01fc400, 24], // AS112-v4
  [0xc034c100, 24], // AMT
  [0xc0586300, 24], // deprecated 6to4 relay anycast
  [0xc0a80000, 16], // RFC1918
  [0xc0af3000, 24], // direct delegation AS112
  [0xc6120000, 15], // benchmarking
  [0xc6336400, 24], // TEST-NET-2
  [0xcb007100, 24], // TEST-NET-3
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved + limited broadcast
];

function ipv4ToUint32(address: string): number | null {
  const parts = address.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return (
    (((parts[0]! << 24) >>> 0) |
      (parts[1]! << 16) |
      (parts[2]! << 8) |
      parts[3]!) >>>
    0
  );
}

function ipv4InRange(value: number, [network, prefixBits]: Ipv4Range): boolean {
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  return (value & mask) >>> 0 === (network & mask) >>> 0;
}

function ipv4Scope(address: string): AddressScope {
  const value = ipv4ToUint32(address);
  if (value === null) return "non-global-unicast";
  if (ipv4InRange(value, [0x7f000000, 8])) return "loopback";
  return NON_GLOBAL_IPV4_RANGES.some((range) => ipv4InRange(value, range))
    ? "non-global-unicast"
    : "global-unicast";
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

type Ipv6Range = readonly [network: bigint, prefixBits: number];

function ipv6ToBigInt(address: string): bigint | null {
  let normalized = address.toLowerCase();
  const embeddedIpv4 = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (embeddedIpv4) {
    const ipv4 = ipv4ToUint32(embeddedIpv4);
    if (ipv4 === null) return null;
    normalized =
      normalized.slice(0, -embeddedIpv4.length) +
      `${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 0 || (halves.length === 2 && zeroCount < 1)) return null;
  const hextets = [...left, ...Array.from({ length: zeroCount }, () => "0"), ...right];
  if (
    hextets.length !== 8 ||
    hextets.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
  ) {
    return null;
  }
  return hextets.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6Literal(value: string): bigint {
  const parsed = ipv6ToBigInt(value);
  if (parsed === null) throw new Error(`Invalid IPv6 policy literal: ${value}`);
  return parsed;
}

function ipv6InRange(value: bigint, [network, prefixBits]: Ipv6Range): boolean {
  const shift = BigInt(128 - prefixBits);
  return (value >> shift) === (network >> shift);
}

const GLOBAL_IPV6_UNICAST: Ipv6Range = [ipv6Literal("2000::"), 3];
const NON_GLOBAL_IPV6_RANGES: readonly Ipv6Range[] = [
  [ipv6Literal("2001::"), 23], // IETF protocol assignments（Teredo/benchmark/ORCHID 等）
  [ipv6Literal("2001:db8::"), 32], // documentation
  [ipv6Literal("2002::"), 16], // 6to4 transition mechanism
  [ipv6Literal("2620:4f:8000::"), 48], // direct delegation AS112
  [ipv6Literal("3fff::"), 20], // documentation
];

function ipv6Scope(address: string): AddressScope {
  const normalized = address.toLowerCase();
  const mappedIPv4 = extractIPv4MappedIPv6(normalized);
  if (mappedIPv4 !== null) {
    return ipv4Scope(mappedIPv4) === "loopback" ? "loopback" : "non-global-unicast";
  }
  const value = ipv6ToBigInt(normalized);
  if (value === null) return "non-global-unicast";
  if (value === 1n) return "loopback";
  if (!ipv6InRange(value, GLOBAL_IPV6_UNICAST)) return "non-global-unicast";
  return NON_GLOBAL_IPV6_RANGES.some((range) => ipv6InRange(value, range))
    ? "non-global-unicast"
    : "global-unicast";
}

function assertAllowedAddress(
  address: string,
  source: string,
  options: FetchUrlValidationOptions,
): void {
  const kind = isIP(address);
  const scope =
    kind === 4
      ? ipv4Scope(address)
      : kind === 6
        ? ipv6Scope(address)
        : "non-global-unicast";
  if (scope === "loopback" && !options.allowLoopback && !options.allowPrivate) {
    throw new Error(`Blocked loopback address for ${source}: ${address}`);
  }
  if (scope === "non-global-unicast" && !options.allowPrivate) {
    // 保留 "Blocked private" 前缀兼容既有上层错误识别，同时明确策略已覆盖全部非全球单播。
    throw new Error(`Blocked private/non-global-unicast address for ${source}: ${address}`);
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
 * 校验出站 URL 并返回本次连接必须使用的地址。域名的全部 DNS 结果都先经过策略校验，
 * 再固定其中一个地址；调用方必须把该地址交给 {@link createPinnedLookup}，不能再次解析域名。
 */
export async function validateAndPinFetchUrl(
  rawUrl: string,
  options: FetchUrlValidationOptions = {},
): Promise<PinnedFetchUrl> {
  const parsed = parseFetchUrl(rawUrl);
  const hostname = parsed.hostname.toLowerCase();
  const addressHostname =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  if (hostname === "localhost") {
    assertFetchAddressAllowed("127.0.0.1", hostname, options);
    return { url: parsed, address: "127.0.0.1", family: 4 };
  }

  const ipKind = isIP(addressHostname);
  if (ipKind) {
    assertFetchAddressAllowed(addressHostname, hostname, options);
    return { url: parsed, address: addressHostname, family: ipKind as 4 | 6 };
  }

  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error(`Could not resolve hostname: ${hostname}`);
  }
  for (const record of records) {
    assertFetchAddressAllowed(record.address, hostname, options);
  }

  const pinned = records[0]!;
  return { url: parsed, address: pinned.address, family: pinned.family as 4 | 6 };
}

/** 为 node:http(s) 创建只返回已校验地址的 lookup，阻止连接阶段二次 DNS 解析。 */
export function createPinnedLookup(target: PinnedFetchUrl): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

/**
 * 只需要做策略判断的调用方沿用 URL 返回值；真正发请求的调用方应使用
 * validateAndPinFetchUrl + createPinnedLookup 将校验结果绑定到连接。
 */
export async function validateFetchUrl(
  rawUrl: string,
  options: FetchUrlValidationOptions = {},
): Promise<URL> {
  return (await validateAndPinFetchUrl(rawUrl, options)).url;
}
