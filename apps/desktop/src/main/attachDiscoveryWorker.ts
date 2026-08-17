import { execFile } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ATTACH_PROTOCOL_VERSION,
  type AttachIdentity,
} from "@qingagent/contract-ts";
import type {
  DiscoveredInstance,
  DiscoveryObservation,
  DiscoveryReport,
} from "./attachDiscoveryTypes.js";

const DISCOVERY_FILE_LIMIT_BYTES = 64 * 1024;
const FILE_IO_DEADLINE_MS = 2_000;
const WSL_COMMAND_DEADLINE_MS = 1_500;
const HEALTH_DEADLINE_MS = 1_200;
const execFileAsync = promisify(execFile);

type DiscoveryFileReadImpl = (filePath: string) => Promise<string | null>;

/**
 * 非 win32 改为主进程内发现后，libuv 文件读一旦挂起便无法随总预算超时取消。
 * 因此按绝对文件路径复用未决读：local 每轮固定只读 instance.json / starting.json，
 * 无论重试多少次，泄漏上界都是 2 个线程池槽；settle 后立即清位，允许后续重试。
 * 这个 2 槽前提依赖 local 不设置 requireReachableHome；若未来增加该选项，额外的
 * HOME lstat 可能把上界推到 4 槽并耗尽默认线程池，届时必须同步重估这里的隔离策略。
 * win32 仍在可整树击杀的 worker 中执行，不依赖这项进程内风险收敛。
 */
const pendingDiscoveryFileReads = new Map<string, Promise<string | null>>();

interface InstanceFile extends AttachIdentity {
  token: string;
}

interface StartingLeaseFile {
  pid: number;
  nonce: string;
  dataDirDigest: string;
  leaseExpiresAt: string;
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && typeof process.argv[index + 1] === "string"
    ? process.argv[index + 1]!
    : null;
}

async function withDeadline<T>(work: Promise<T>, deadlineMs = FILE_IO_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("read timeout"), {
          code: "READ_TIMEOUT",
        })), deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readDiscoveryFileUnshared(filePath: string): Promise<string | null> {
  try {
    const before = await lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("not regular");
    if (before.size > DISCOVERY_FILE_LIMIT_BYTES) throw new Error("too large");
    const handle = await open(filePath, "r");
    try {
      const after = await handle.stat();
      if (
        !after.isFile()
        || after.size > DISCOVERY_FILE_LIMIT_BYTES
        || after.dev !== before.dev
        || after.ino !== before.ino
      ) throw new Error("discovery file changed during read");
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readDiscoveryFile(
  filePath: string,
  readImpl: DiscoveryFileReadImpl = readDiscoveryFileUnshared,
): Promise<string | null> {
  const existing = pendingDiscoveryFileReads.get(filePath);
  if (existing) return withDeadline(existing);

  const pending = Promise.resolve().then(() => readImpl(filePath));
  pendingDiscoveryFileReads.set(filePath, pending);
  const clear = (): void => {
    if (pendingDiscoveryFileReads.get(filePath) === pending) {
      pendingDiscoveryFileReads.delete(filePath);
    }
  };
  void pending.then(clear, clear);
  // 每个调用者仍有独立 2s 预算，但单飞表只在不可取消的底层 I/O 真正 settle 后清位。
  return withDeadline(pending);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseInstance(raw: string): { kind: "ok"; value: InstanceFile } | { kind: "incompatible" } {
  const value = JSON.parse(raw) as Partial<InstanceFile>;
  if (
    value.schemaVersion !== 2
    || !Number.isInteger(value.port) || value.port! < 1 || value.port! > 65_535
    || !Number.isInteger(value.pid) || value.pid! < 1
    || typeof value.version !== "string" || value.version.length === 0
    || !Number.isInteger(value.attachProtocolVersion)
    || !isUuid(value.instanceId)
    || !isUuid(value.libraryId)
    || typeof value.token !== "string" || !/^qa_instance_[0-9a-f]{64}$/i.test(value.token)
    || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))
  ) throw new Error("malformed instance");
  if (value.attachProtocolVersion !== ATTACH_PROTOCOL_VERSION) return { kind: "incompatible" };
  return { kind: "ok", value: value as InstanceFile };
}

function parseStartingLease(raw: string): StartingLeaseFile {
  const value = JSON.parse(raw) as Partial<StartingLeaseFile>;
  if (
    !Number.isInteger(value.pid) || value.pid! < 1
    || typeof value.nonce !== "string" || !/^[0-9a-f]{64}$/i.test(value.nonce)
    || typeof value.dataDirDigest !== "string" || !/^[0-9a-f]{64}$/i.test(value.dataDirDigest)
    || typeof value.leaseExpiresAt !== "string"
    || !Number.isFinite(Date.parse(value.leaseExpiresAt))
  ) throw new Error("malformed lease");
  return value as StartingLeaseFile;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function identityMatches(actual: unknown, expected: InstanceFile): boolean {
  if (!actual || typeof actual !== "object") return false;
  const value = actual as Record<string, unknown>;
  return value.schemaVersion === expected.schemaVersion
    && value.port === expected.port
    && value.pid === expected.pid
    && value.version === expected.version
    && value.attachProtocolVersion === expected.attachProtocolVersion
    && value.instanceId === expected.instanceId
    && value.libraryId === expected.libraryId
    && value.startedAt === expected.startedAt;
}

async function probeInstance(
  instance: InstanceFile,
  source: string,
  sameProcessNamespace: boolean | undefined,
): Promise<DiscoveryObservation> {
  const endpoint = `http://127.0.0.1:${instance.port}`;
  let response: Response;
  try {
    response = await fetch(`${endpoint}/api/v1/external/health`, {
      headers: { Authorization: `Bearer ${instance.token}` },
      signal: AbortSignal.timeout(HEALTH_DEADLINE_MS),
    });
  } catch {
    // 只有同一进程命名空间内才能用 PID 否定实例存活；跨 WSL/Windows 仍保持不确定。
    if (sameProcessNamespace !== false && !pidAlive(instance.pid)) {
      return { source, state: "absent" };
    }
    return { source, state: "indeterminate", errorCode: "UNREACHABLE" };
  }
  if (response.status === 401 || response.status === 403) {
    return { source, state: "indeterminate", errorCode: "AUTH_FAILED" };
  }
  if (!response.ok) return { source, state: "indeterminate", errorCode: "UNREACHABLE" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { source, state: "conflict", errorCode: "CONFLICT" };
  }
  if (!identityMatches(body, instance)) {
    return { source, state: "conflict", errorCode: "CONFLICT" };
  }
  const discovered: DiscoveredInstance = { ...instance, endpoint, source };
  return { source, state: "valid", instance: discovered };
}

interface InspectCandidateOptions {
  requireReachableHome?: boolean;
  sameProcessNamespace?: boolean;
  /** 仅供对抗性测试注入底层不可取消的文件读。 */
  readDiscoveryFileImpl?: DiscoveryFileReadImpl;
}

export async function inspectCandidate(
  source: string,
  home: string,
  options: InspectCandidateOptions = {},
): Promise<DiscoveryObservation> {
  if (options.requireReachableHome) {
    try {
      const stats = await withDeadline(lstat(home));
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("home not directory");
    } catch (error) {
      return {
        source,
        state: "indeterminate",
        errorCode: (error as { code?: unknown }).code === "READ_TIMEOUT"
          ? "READ_TIMEOUT"
          : "HOME_UNREACHABLE",
      };
    }
  }
  const discoveryDir = path.join(home, ".qingagent");
  let instanceRaw: string | null;
  let startingRaw: string | null;
  try {
    [instanceRaw, startingRaw] = await Promise.all([
      readDiscoveryFile(
        path.join(discoveryDir, "instance.json"),
        options.readDiscoveryFileImpl,
      ),
      readDiscoveryFile(
        path.join(discoveryDir, "starting.json"),
        options.readDiscoveryFileImpl,
      ),
    ]);
  } catch (error) {
    return {
      source,
      state: "indeterminate",
      errorCode: (error as { code?: unknown }).code === "READ_TIMEOUT"
        ? "READ_TIMEOUT"
        : "MALFORMED",
    };
  }

  if (instanceRaw !== null) {
    try {
      const parsed = parseInstance(instanceRaw);
      if (parsed.kind === "incompatible") {
        return { source, state: "incompatible", errorCode: "INCOMPATIBLE" };
      }
      return await probeInstance(parsed.value, source, options.sameProcessNamespace);
    } catch {
      return { source, state: "indeterminate", errorCode: "MALFORMED" };
    }
  }

  if (startingRaw !== null) {
    try {
      const lease = parseStartingLease(startingRaw);
      const expired = Date.parse(lease.leaseExpiresAt) <= Date.now();
      // WSL/Linux pid 与 Windows worker 不共享进程命名空间，跨界只能信租约时钟。
      if (!expired || (options.sameProcessNamespace !== false && pidAlive(lease.pid))) {
        return { source, state: "indeterminate", errorCode: "STARTING_LEASE" };
      }
    } catch {
      return { source, state: "indeterminate", errorCode: "MALFORMED" };
    }
  }
  if (options.requireReachableHome) {
    try {
      const stats = await withDeadline(lstat(home));
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("home not directory");
    } catch (error) {
      return {
        source,
        state: "indeterminate",
        errorCode: (error as { code?: unknown }).code === "READ_TIMEOUT"
          ? "READ_TIMEOUT"
          : "HOME_UNREACHABLE",
      };
    }
  }
  return { source, state: "absent" };
}

export function decodeWslOutput(value: string | Buffer): string {
  if (typeof value === "string") return value;
  if (value.length >= 2 && (value[0] === 0xff && value[1] === 0xfe)) {
    return value.subarray(2).toString("utf16le");
  }
  let zeroCount = 0;
  for (let index = 1; index < Math.min(value.length, 128); index += 2) {
    if (value[index] === 0) zeroCount += 1;
  }
  return zeroCount >= 2 ? value.toString("utf16le") : value.toString("utf8");
}

async function runWsl(args: string[]): Promise<string> {
  const result = await execFileAsync("wsl.exe", args, {
    encoding: "buffer",
    timeout: WSL_COMMAND_DEADLINE_MS,
    windowsHide: true,
    maxBuffer: 128 * 1024,
  });
  return decodeWslOutput(result.stdout).replace(/^\uFEFF/, "").trim();
}

export function wslUncHomes(distro: string, linuxHome: string): readonly [string, string] {
  const normalized = linuxHome.replace(/^\/+/, "").replaceAll("/", "\\");
  return [
    `\\\\wsl.localhost\\${distro}\\${normalized}`,
    `\\\\wsl$\\${distro}\\${normalized}`,
  ];
}

export async function inspectWslCandidate(
  source: string,
  distro: string,
  linuxHome: string,
  inspectCandidateImpl: typeof inspectCandidate = inspectCandidate,
): Promise<DiscoveryObservation> {
  let fallbackErrorCode: "HOME_UNREACHABLE" | "READ_TIMEOUT" = "HOME_UNREACHABLE";
  for (const home of wslUncHomes(distro, linuxHome)) {
    const observation = await inspectCandidateImpl(source, home, {
      requireReachableHome: true,
      sameProcessNamespace: false,
    });
    if (
      observation.state !== "indeterminate"
      || (observation.errorCode !== "HOME_UNREACHABLE" && observation.errorCode !== "READ_TIMEOUT")
    ) {
      return observation;
    }
    if (observation.errorCode === "READ_TIMEOUT") fallbackErrorCode = "READ_TIMEOUT";
  }
  return { source, state: "indeterminate", errorCode: fallbackErrorCode };
}

interface DiscoverWslOptions {
  runWslImpl?: (args: string[]) => Promise<string>;
  inspectWslCandidateImpl?: typeof inspectWslCandidate;
}

export async function discoverWsl(options: DiscoverWslOptions = {}): Promise<DiscoveryObservation[]> {
  const run = options.runWslImpl ?? runWsl;
  const inspect = options.inspectWslCandidateImpl ?? inspectWslCandidate;
  let distros: string[];
  try {
    const output = await run(["--list", "--running", "--quiet"]);
    distros = output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [{ source: "wsl", state: "absent", errorCode: "WSL_NOT_INSTALLED" }];
    }
    return [{ source: "wsl", state: "indeterminate", errorCode: "ENUM_FAILED" }];
  }
  if (distros.length === 0) {
    return [{ source: "wsl", state: "absent", errorCode: "WSL_STOPPED" }];
  }

  const observations: DiscoveryObservation[] = [];
  for (let index = 0; index < distros.length; index += 2) {
    const batch = distros.slice(index, index + 2);
    observations.push(...await Promise.all(batch.map(async (distro) => {
      let linuxHome: string;
      try {
        linuxHome = await run(["-d", distro, "--", "printenv", "HOME"]);
      } catch {
        // docker-desktop 等基础设施发行版通常没有常规用户 HOME；只降级当前候选。
        return { source: `wsl:${distro}`, state: "absent", errorCode: "HOME_FAILED" } as const;
      }
      if (!linuxHome.startsWith("/")) {
        return { source: `wsl:${distro}`, state: "absent", errorCode: "HOME_FAILED" } as const;
      }
      return inspect(`wsl:${distro}`, distro, linuxHome);
    })));
  }
  return observations;
}

export async function discoverLocalObservations(
  home: string,
  inspectCandidateImpl: typeof inspectCandidate = inspectCandidate,
): Promise<DiscoveryObservation[]> {
  if (!home) {
    return [{ source: "local", state: "indeterminate", errorCode: "ENUM_FAILED" }];
  }
  return [await inspectCandidateImpl("local", home, { sameProcessNamespace: true })];
}

async function main(): Promise<void> {
  const home = argument("--home");
  const platform = argument("--platform") ?? process.platform;
  const observations = await discoverLocalObservations(home ?? "");
  if (platform === "win32") observations.push(...await discoverWsl());
  const report: DiscoveryReport = { observations };
  process.stdout.write(JSON.stringify(report), () => process.exit(0));
}

const workerEntryPath = fileURLToPath(import.meta.url);
const workerEntryName = path.basename(workerEntryPath);
const isDirectExecution = typeof process.argv[1] === "string"
  && path.resolve(process.argv[1]) === workerEntryPath
  // esbuild 会把本模块内联进 index / packaged smoke；仅 worker 固定入口可执行 main。
  && (workerEntryName === "attachDiscoveryWorker.ts"
    || workerEntryName === "attach-discovery-worker.js");

if (isDirectExecution) {
  void main().catch(() => {
    const report: DiscoveryReport = {
      observations: [{ source: "worker", state: "indeterminate", errorCode: "ENUM_FAILED" }],
    };
    process.stdout.write(JSON.stringify(report), () => process.exit(0));
  });
}
