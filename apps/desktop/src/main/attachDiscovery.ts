import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { ATTACH_PROTOCOL_VERSION } from "@qingagent/contract-ts";
import type {
  DiscoveredInstance,
  DiscoveryErrorCode,
  DiscoveryObservation,
  DiscoveryReport,
} from "./attachDiscoveryTypes.js";
import { discoverLocalObservations } from "./attachDiscoveryWorker.js";

export const DISCOVERY_TOTAL_DEADLINE_MS = 8_000;
const MAX_DISCOVERY_OUTPUT_BYTES = 1024 * 1024;

export interface AttachDiscoveryOptions {
  home: string;
  platform?: NodeJS.Platform;
  workerPath: string;
  developmentWorker?: boolean;
  execPath?: string;
  deadlineMs?: number;
  spawnWorker?: typeof spawn;
  /** 仅用于覆盖进程内发现的超时与意外异常护栏。 */
  discoverLocalObservationsImpl?: typeof discoverLocalObservations;
}

function failedReport(errorCode: "READ_TIMEOUT" | "ENUM_FAILED"): DiscoveryReport {
  return {
    observations: [{ source: "worker", state: "indeterminate", errorCode }],
  };
}

function killProcessTree(child: ChildProcess, platform: NodeJS.Platform): void {
  if (!child.pid) return;
  if (platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref();
    } catch {
      child.kill("SIGKILL");
    }
    return;
  }
  child.kill("SIGKILL");
}

const DISCOVERY_ERROR_CODES = new Set<DiscoveryErrorCode>([
  "WSL_NOT_INSTALLED",
  "WSL_STOPPED",
  "ENUM_FAILED",
  "HOME_FAILED",
  "HOME_UNREACHABLE",
  "READ_TIMEOUT",
  "MALFORMED",
  "UNREACHABLE",
  "AUTH_FAILED",
  "INCOMPATIBLE",
  "CONFLICT",
  "STARTING_LEASE",
]);

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSource(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isDiscoveredInstance(value: unknown): value is DiscoveredInstance {
  if (!value || typeof value !== "object") return false;
  const instance = value as Partial<DiscoveredInstance>;
  return instance.schemaVersion === 2
    && Number.isInteger(instance.port) && instance.port! >= 1 && instance.port! <= 65_535
    && Number.isInteger(instance.pid) && instance.pid! >= 1
    && typeof instance.version === "string" && instance.version.length > 0 && instance.version.length <= 128
    && instance.attachProtocolVersion === ATTACH_PROTOCOL_VERSION
    && isUuid(instance.instanceId)
    && isUuid(instance.libraryId)
    && typeof instance.token === "string" && /^qa_instance_[0-9a-f]{64}$/i.test(instance.token)
    && typeof instance.startedAt === "string" && Number.isFinite(Date.parse(instance.startedAt))
    && isSource(instance.source)
    && instance.endpoint === `http://127.0.0.1:${instance.port}`;
}

function isDiscoveryObservation(value: unknown): value is DiscoveryObservation {
  if (!value || typeof value !== "object") return false;
  const observation = value as Partial<DiscoveryObservation> & { errorCode?: unknown };
  if (!isSource(observation.source)) return false;
  if (observation.state === "valid") {
    const instance = (observation as { instance?: unknown }).instance;
    return isDiscoveredInstance(instance) && instance.source === observation.source;
  }
  if (observation.state === "absent") {
    return observation.errorCode === undefined
      || observation.errorCode === "WSL_NOT_INSTALLED"
      || observation.errorCode === "WSL_STOPPED"
      || observation.errorCode === "HOME_FAILED";
  }
  if (
    observation.state !== "indeterminate"
    && observation.state !== "incompatible"
    && observation.state !== "conflict"
  ) return false;
  if (typeof observation.errorCode !== "string"
    || !DISCOVERY_ERROR_CODES.has(observation.errorCode as DiscoveryErrorCode)) return false;
  if (observation.state === "incompatible") return observation.errorCode === "INCOMPATIBLE";
  if (observation.state === "conflict") return observation.errorCode === "CONFLICT";
  return true;
}

/** 子进程输出仍按不可信输入校验，避免被污染的 stdout 注入任意转发目标或 token。 */
export function isDiscoveryReport(value: unknown): value is DiscoveryReport {
  if (!value || typeof value !== "object") return false;
  const observations = (value as { observations?: unknown }).observations;
  return Array.isArray(observations)
    && observations.length > 0
    && observations.length <= 256
    && observations.every(isDiscoveryObservation);
}

function discoverLocalInProcess(options: AttachDiscoveryOptions): Promise<DiscoveryReport> {
  const discover = options.discoverLocalObservationsImpl ?? discoverLocalObservations;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (report: DiscoveryReport): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(report);
    };
    const deadline = setTimeout(() => {
      finish(failedReport("READ_TIMEOUT"));
    }, options.deadlineMs ?? DISCOVERY_TOTAL_DEADLINE_MS);

    void Promise.resolve()
      .then(() => discover(path.resolve(options.home)))
      .then(
        (observations) => finish({ observations }),
        () => finish(failedReport("ENUM_FAILED")),
      );
  });
}

/**
 * 非 Windows 的本地文件发现在主进程内执行；Windows 仍由可整树击杀的 worker
 * 隔离 WSL 枚举与 UNC 读取，并由父进程以 8s 总预算收口。
 */
export function discoverAttachInstances(options: AttachDiscoveryOptions): Promise<DiscoveryReport> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return discoverLocalInProcess(options);

  const developmentWorker = options.developmentWorker === true;
  const args = developmentWorker
    ? ["--import", "tsx", options.workerPath]
    : [options.workerPath];
  args.push("--home", path.resolve(options.home), "--platform", platform);
  const spawnImpl = options.spawnWorker ?? spawn;

  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const child = spawnImpl(options.execPath ?? process.execPath, args, {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const finish = (report: DiscoveryReport): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(report);
    };
    const deadline = setTimeout(() => {
      killProcessTree(child, platform);
      finish(failedReport("READ_TIMEOUT"));
    }, options.deadlineMs ?? DISCOVERY_TOTAL_DEADLINE_MS);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_DISCOVERY_OUTPUT_BYTES) {
        killProcessTree(child, platform);
        finish(failedReport("ENUM_FAILED"));
      }
    });
    child.once("error", () => finish(failedReport("ENUM_FAILED")));
    child.once("close", () => {
      if (settled) return;
      try {
        const parsed = JSON.parse(output) as unknown;
        finish(isDiscoveryReport(parsed) ? parsed : failedReport("ENUM_FAILED"));
      } catch {
        finish(failedReport("ENUM_FAILED"));
      }
    });
  });
}
