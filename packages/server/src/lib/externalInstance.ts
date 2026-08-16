import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ATTACH_PROTOCOL_VERSION,
  type AttachIdentity,
} from "@qingagent/contract-ts";
import { revokeAllAttachSessions } from "./attachSessions";
import { isValidLibraryId } from "./libraryId";

export const INSTANCE_SCHEMA_VERSION = 2 as const;
export const INSTANCE_TOKEN_PREFIX = "qa_instance_";
export const STARTING_LEASE_DURATION_MS = 15_000;
export const STARTING_LEASE_HEARTBEAT_MS = 5_000;
const DISCOVERY_FILE_LIMIT_BYTES = 64 * 1024;

export interface ExternalInstanceInfo extends AttachIdentity {
  token: string;
}

export interface StartingLeaseInfo {
  pid: number;
  nonce: string;
  dataDirDigest: string;
  leaseExpiresAt: string;
}

export interface StartingLease {
  readonly filePath: string;
  readonly info: StartingLeaseInfo;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export type AcquireStartingLeaseResult =
  | { kind: "acquired"; lease: StartingLease }
  | { kind: "existing"; instance: ExternalInstanceInfo };

let current: ExternalInstanceInfo | null = null;
let currentFilePath: string | null = null;
let hooksInstalled = false;
const ownedLeaseNonces = new Map<string, string>();

export function externalInstancePath(home = os.homedir()): string {
  return path.join(home, ".qingagent", "instance.json");
}

export function startingInstancePath(instancePath = externalInstancePath()): string {
  return path.join(path.dirname(instancePath), "starting.json");
}

export function dataDirDigest(databaseUrl: string): string {
  const normalized = databaseUrl.trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function getExternalToken(): string | null {
  return current?.token ?? null;
}

export function getExternalInstance(): ExternalInstanceInfo | null {
  return current ? { ...current } : null;
}

export function getExternalInstancePublicInfo(): AttachIdentity | null {
  if (!current) return null;
  const { token: _token, ...publicInfo } = current;
  return publicInfo;
}

export async function readExternalInstanceFile(
  filePath = externalInstancePath(),
): Promise<ExternalInstanceInfo> {
  return parseExternalInstanceInfo(await readRegularFile(filePath));
}

export async function readStartingLeaseFile(filePath: string): Promise<StartingLeaseInfo> {
  return parseStartingLeaseInfo(await readRegularFile(filePath));
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/** 同一文件系统完整所有权序的入口；必须在迁移等慢副作用之前调用。 */
export async function acquireStartingLease(options: {
  instanceFilePath?: string;
  dataDirDigest: string;
  leaseDurationMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  probeInstance?: (instance: ExternalInstanceInfo) => Promise<boolean>;
}): Promise<AcquireStartingLeaseResult> {
  const instanceFilePath = options.instanceFilePath ?? externalInstancePath();
  const leaseFilePath = startingInstancePath(instanceFilePath);
  const now = options.now ?? Date.now;
  const leaseDurationMs = options.leaseDurationMs ?? STARTING_LEASE_DURATION_MS;
  const existing = await inspectExistingInstance(
    instanceFilePath,
    options.probeInstance ?? probeExternalInstance,
  );
  if (existing) return { kind: "existing", instance: existing };

  await mkdir(path.dirname(leaseFilePath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const info: StartingLeaseInfo = {
      pid: process.pid,
      nonce: randomBytes(32).toString("hex"),
      dataDirDigest: options.dataDirDigest,
      leaseExpiresAt: new Date(now() + leaseDurationMs).toISOString(),
    };
    try {
      await createLeaseFileExclusive(leaseFilePath, info);
      ownedLeaseNonces.set(leaseFilePath, info.nonce);
      installCleanupHooks();
      return {
        kind: "acquired",
        lease: createStartingLease({
          filePath: leaseFilePath,
          info,
          durationMs: leaseDurationMs,
          heartbeatMs: options.heartbeatMs ?? STARTING_LEASE_HEARTBEAT_MS,
          now,
        }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existingLease: StartingLeaseInfo;
      try {
        existingLease = await readStartingLeaseFile(leaseFilePath);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        if (!isMalformedStartingLeaseError(readError)) throw readError;
        const recovered = await removeStaleMalformedStartingLease(
          leaseFilePath,
          now(),
          leaseDurationMs,
        );
        if (!recovered) throw new Error("another Qingagent instance is starting");
        const releasedInstance = await inspectExistingInstance(
          instanceFilePath,
          options.probeInstance ?? probeExternalInstance,
        );
        if (releasedInstance) return { kind: "existing", instance: releasedInstance };
        continue;
      }
      const expired = Date.parse(existingLease.leaseExpiresAt) <= now();
      if (!expired || isPidAlive(existingLease.pid)) {
        throw new Error("another Qingagent instance is starting");
      }
      await removeFileIfNonceMatches(leaseFilePath, existingLease.nonce);
      const releasedInstance = await inspectExistingInstance(
        instanceFilePath,
        options.probeInstance ?? probeExternalInstance,
      );
      if (releasedInstance) return { kind: "existing", instance: releasedInstance };
    }
  }
  throw new Error("unable to acquire starting lease");
}

export async function startExternalInstance(options: {
  port: number;
  libraryId: string;
  version?: string;
  filePath?: string;
  lease?: StartingLease;
}): Promise<ExternalInstanceInfo> {
  if (!isValidLibraryId(options.libraryId)) throw new Error("invalid libraryId");
  await options.lease?.assertOwned();
  const version = options.version ?? await readPackageVersion();
  const filePath = options.filePath ?? externalInstancePath();
  const info: ExternalInstanceInfo = {
    schemaVersion: INSTANCE_SCHEMA_VERSION,
    port: options.port,
    pid: process.pid,
    version,
    attachProtocolVersion: ATTACH_PROTOCOL_VERSION,
    instanceId: randomUUID(),
    libraryId: options.libraryId,
    token: `${INSTANCE_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`,
    startedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(filePath, info);
  current = info;
  currentFilePath = filePath;
  installCleanupHooks();
  await options.lease?.release();
  return { ...info };
}

export async function stopExternalInstance(filePath = currentFilePath ?? externalInstancePath()): Promise<void> {
  const instanceId = current?.instanceId;
  current = null;
  currentFilePath = null;
  revokeAllAttachSessions();
  if (instanceId && await instanceFileOwnedByInstance(filePath, instanceId)) {
    await rm(filePath, { force: true }).catch(() => undefined);
  }
}

export async function probeExternalInstance(
  info: ExternalInstanceInfo,
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/v1/external/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json() as unknown;
    return identityFieldsEqual(body, info);
  } catch {
    return false;
  }
}

export function identityFieldsEqual(actual: unknown, expected: AttachIdentity): boolean {
  if (actual === null || typeof actual !== "object") return false;
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

function createStartingLease(options: {
  filePath: string;
  info: StartingLeaseInfo;
  durationMs: number;
  heartbeatMs: number;
  now: () => number;
}): StartingLease {
  let failure: unknown = null;
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing || failure) return;
    renewing = true;
    void renewLease(options.filePath, options.info, options.durationMs, options.now)
      .catch((error) => { failure = error; })
      .finally(() => { renewing = false; });
  }, options.heartbeatMs);
  heartbeat.unref();

  return {
    filePath: options.filePath,
    info: options.info,
    async assertOwned() {
      if (failure) throw failure;
      const disk = await readStartingLeaseFile(options.filePath);
      if (disk.nonce !== options.info.nonce) throw new Error("starting lease ownership lost");
    },
    async release() {
      clearInterval(heartbeat);
      await removeFileIfNonceMatches(options.filePath, options.info.nonce);
      ownedLeaseNonces.delete(options.filePath);
    },
  };
}

async function renewLease(
  filePath: string,
  info: StartingLeaseInfo,
  durationMs: number,
  now: () => number,
): Promise<void> {
  const disk = await readStartingLeaseFile(filePath);
  if (disk.nonce !== info.nonce) throw new Error("starting lease ownership lost");
  info.leaseExpiresAt = new Date(now() + durationMs).toISOString();
  await writeJsonAtomic(filePath, info);
}

async function inspectExistingInstance(
  filePath: string,
  probe: (instance: ExternalInstanceInfo) => Promise<boolean>,
): Promise<ExternalInstanceInfo | null> {
  let info: ExternalInstanceInfo;
  try {
    info = await readExternalInstanceFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (await probe(info)) return info;
  if (isPidAlive(info.pid)) {
    throw new Error("instance.json owner is alive but authenticated health failed");
  }
  await removeInstanceIfIdMatches(filePath, info.instanceId);
  return null;
}

async function createLeaseFileExclusive(filePath: string, info: StartingLeaseInfo): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600).catch(() => undefined);
  await syncDirectory(path.dirname(filePath));
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, filePath);
    await chmod(filePath, 0o600).catch(() => undefined);
    await syncDirectory(dir);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && ["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      return;
    }
    throw error;
  }
}

async function readRegularFile(filePath: string): Promise<string> {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("discovery path is not a regular file");
  if (stats.size > DISCOVERY_FILE_LIMIT_BYTES) throw new Error("discovery file is too large");
  return readFile(filePath, "utf8");
}

function parseExternalInstanceInfo(raw: string): ExternalInstanceInfo {
  const value = JSON.parse(raw) as Partial<ExternalInstanceInfo>;
  if (
    value.schemaVersion !== INSTANCE_SCHEMA_VERSION
    || !Number.isInteger(value.port) || (value.port ?? 0) < 1 || (value.port ?? 0) > 65_535
    || !Number.isInteger(value.pid) || (value.pid ?? 0) < 1
    || typeof value.version !== "string" || !value.version
    || value.attachProtocolVersion !== ATTACH_PROTOCOL_VERSION
    || typeof value.instanceId !== "string" || !value.instanceId
    || !isValidLibraryId(value.libraryId)
    || typeof value.token !== "string" || !value.token.startsWith(INSTANCE_TOKEN_PREFIX)
    || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))
  ) {
    throw new Error("instance.json is malformed or incompatible");
  }
  return value as ExternalInstanceInfo;
}

function parseStartingLeaseInfo(raw: string): StartingLeaseInfo {
  const value = JSON.parse(raw) as Partial<StartingLeaseInfo>;
  if (
    !Number.isInteger(value.pid) || (value.pid ?? 0) < 1
    || typeof value.nonce !== "string" || !/^[0-9a-f]{64}$/i.test(value.nonce)
    || typeof value.dataDirDigest !== "string" || !/^[0-9a-f]{64}$/i.test(value.dataDirDigest)
    || typeof value.leaseExpiresAt !== "string"
    || !Number.isFinite(Date.parse(value.leaseExpiresAt))
  ) {
    throw new Error("starting.json is malformed");
  }
  return value as StartingLeaseInfo;
}

function isMalformedStartingLeaseError(error: unknown): boolean {
  return error instanceof SyntaxError
    || (error instanceof Error && error.message === "starting.json is malformed");
}

async function removeStaleMalformedStartingLease(
  filePath: string,
  nowMs: number,
  leaseDurationMs: number,
): Promise<boolean> {
  const observed = await stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!observed) return true;
  if (nowMs - observed.mtimeMs < leaseDurationMs) return false;

  const current = await stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!current) return true;
  if (
    current.dev !== observed.dev
    || current.ino !== observed.ino
    || current.size !== observed.size
    || current.mtimeMs !== observed.mtimeMs
  ) return false;
  await rm(filePath);
  return true;
}

async function removeFileIfNonceMatches(filePath: string, nonce: string): Promise<void> {
  const currentLease = await readStartingLeaseFile(filePath).catch(() => null);
  if (currentLease?.nonce === nonce) await rm(filePath, { force: true });
}

async function removeInstanceIfIdMatches(filePath: string, instanceId: string): Promise<void> {
  const disk = await readExternalInstanceFile(filePath).catch(() => null);
  if (disk?.instanceId === instanceId) await rm(filePath, { force: true });
}

function installCleanupHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.once("exit", () => {
    for (const [filePath, nonce] of ownedLeaseNonces) {
      if (fileOwnedByFieldSync(filePath, "nonce", nonce)) {
        try { rmSync(filePath, { force: true }); } catch { /* best effort */ }
      }
    }
    if (current && currentFilePath && fileOwnedByFieldSync(currentFilePath, "instanceId", current.instanceId)) {
      try { rmSync(currentFilePath, { force: true }); } catch { /* best effort */ }
    }
  });
}

async function instanceFileOwnedByInstance(filePath: string, instanceId: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { instanceId?: unknown };
    return parsed.instanceId === instanceId;
  } catch {
    return false;
  }
}

function fileOwnedByFieldSync(filePath: string, field: string, expected: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return parsed[field] === expected;
  } catch {
    return false;
  }
}

async function readPackageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
