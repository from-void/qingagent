import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetCrashGuardForTest, gracefulShutdownForTest } from "../crashGuard";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

function captureOutput(child: ReturnType<typeof spawn>): {
  read: () => string;
  waitFor: (needle: string, timeoutMs: number) => Promise<void>;
} {
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  return {
    read: () => output,
    waitFor: async (needle, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (output.includes(needle)) return;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `child exited before output ${JSON.stringify(needle)}: code=${child.exitCode} signal=${child.signalCode}\n${output}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      child.kill("SIGKILL");
      throw new Error(`child output timeout after ${timeoutMs}ms: ${needle}\n${output}`);
    },
  };
}

async function waitForStartup(
  child: ReturnType<typeof spawn>,
  readyFile: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `child exited before startup wait: code=${child.exitCode} signal=${child.signalCode}`,
      );
    }
    try {
      await stat(readyFile);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGKILL");
  throw new Error(`child startup timeout after ${timeoutMs}ms`);
}

function waitExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("child exit timeout"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("crashGuard graceful shutdown", () => {
  afterEach(() => {
    __resetCrashGuardForTest();
  });

  it("SIGTERM drain 顺序为 active turn → session persistence → observability", async () => {
    const order: string[] = [];
    const exit = vi.fn();

    await gracefulShutdownForTest("SIGTERM", {
      exit,
      drainActiveTurns: async () => {
        order.push("active");
      },
      drainPersistence: async () => {
        order.push("persist");
      },
      flushObservability: async () => {
        order.push("observability");
      },
    });

    expect(order).toEqual(["active", "persist", "observability"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("真实 SIGTERM 会进入 crashGuard handler 并正常退出", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "qingagent-crashguard-"));
    const readyFile = join(logDir, "ready");
    try {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          "-e",
          "import './src/crashGuard.ts'; import { writeFileSync } from 'node:fs'; writeFileSync(process.env.READY_FILE, 'ready'); setInterval(() => {}, 1000);",
        ],
        {
          cwd: SERVER_DIR,
          env: {
            ...process.env,
            QINGAGENT_LOG_DIR: logDir,
            READY_FILE: readyFile,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      await waitForStartup(child, readyFile, 10_000);
      child.kill("SIGTERM");
      await expect(waitExit(child, 15_000)).resolves.toBe(0);

      const files = await readdir(logDir);
      const logFile = files.find((file) => file.startsWith("server-") && file.endsWith(".log"));
      expect(logFile).toBeTruthy();
      const log = await readFile(join(logDir, logFile!), "utf8");
      expect(log).toContain("received SIGTERM, shutting down gracefully");
      expect(log).toContain("shutdown complete (SIGTERM)");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("生成中收到 SIGTERM 会完成 drain、清理实例文件并正常退出", async () => {
    const logDir = await mkdtemp(join(tmpdir(), "qingagent-crashguard-active-"));
    const instanceFile = join(logDir, "instance.json");
    const activeTurnMarker = join(logDir, "active-turn-drained");
    const readyFile = join(logDir, "ready");
    try {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          "-e",
          [
            "import { __setSignalShutdownDepsForTest } from './src/crashGuard.ts';",
            "import { writeFileSync } from 'node:fs';",
            "import { startExternalInstance } from './src/lib/externalInstance.ts';",
            "__setSignalShutdownDepsForTest({ drainActiveTurns: () => new Promise((resolve) => setTimeout(() => { writeFileSync(process.env.ACTIVE_TURN_MARKER, 'drained'); resolve(); }, 100)), drainPersistence: async () => {}, flushObservability: async () => {} });",
            "await startExternalInstance({ port: 52341, version: 'test', filePath: process.env.INSTANCE_FILE });",
            "writeFileSync(process.env.READY_FILE, 'ready');",
            "setInterval(() => {}, 1000);",
          ].join(" "),
        ],
        {
          cwd: SERVER_DIR,
          env: {
            ...process.env,
            ACTIVE_TURN_MARKER: activeTurnMarker,
            INSTANCE_FILE: instanceFile,
            QINGAGENT_LOG_DIR: logDir,
            READY_FILE: readyFile,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      await waitForStartup(child, readyFile, 10_000);
      child.kill("SIGTERM");
      await expect(waitExit(child, 15_000)).resolves.toBe(0);

      await expect(readFile(activeTurnMarker, "utf8")).resolves.toBe("drained");
      await expect(stat(instanceFile)).rejects.toMatchObject({ code: "ENOENT" });
      const files = await readdir(logDir);
      const logFile = files.find((file) => file.startsWith("server-") && file.endsWith(".log"));
      expect(logFile).toBeTruthy();
      const log = await readFile(join(logDir, logFile!), "utf8");
      expect(log).toContain("active_turn_drain completed");
      expect(log).toContain("session_persistence_drain completed");
      expect(log).toContain("observability_flush completed");
      expect(log).toContain("shutdown complete (SIGTERM)");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("真实 server 入口收到 SIGTERM 不会被依赖的退出处理器抢断", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "qingagent-server-sigterm-"));
    const instanceFile = join(tempDir, "instance.json");
    try {
      const child = spawn(process.execPath, [TSX_CLI, "src/index.ts"], {
        cwd: SERVER_DIR,
        env: {
          ...process.env,
          DATABASE_URL: `file:${join(tempDir, "server.db")}`,
          PORT: "0",
          QINGAGENT_INSTANCE_FILE: instanceFile,
          QINGAGENT_LOG_DIR: tempDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = captureOutput(child);

      await output.waitFor("Qingagent server listening", 20_000);
      await waitForStartup(child, instanceFile, 10_000);
      child.kill("SIGTERM");
      await expect(waitExit(child, 15_000), output.read()).resolves.toBe(0);

      await expect(stat(instanceFile)).rejects.toMatchObject({ code: "ENOENT" });
      const files = await readdir(tempDir);
      const logFile = files.find((file) => file.startsWith("server-") && file.endsWith(".log"));
      expect(logFile).toBeTruthy();
      const log = await readFile(join(tempDir, logFile!), "utf8");
      expect(log).toContain("removed competing SIGTERM shutdown handlers");
      expect(log).toContain("active_turn_drain completed");
      expect(log).toContain("session_persistence_drain completed");
      expect(log).toContain("observability_flush completed");
      expect(log).toContain("shutdown complete (SIGTERM)");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 40_000);
});
