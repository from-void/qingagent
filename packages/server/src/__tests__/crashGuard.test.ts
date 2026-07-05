import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetCrashGuardForTest, gracefulShutdownForTest } from "../crashGuard";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");

function waitForStartup(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`child exited before startup wait: code=${code} signal=${signal}`));
    });
  });
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
    try {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          "-e",
          "import './src/crashGuard.ts'; console.log('ready'); setInterval(() => {}, 1000);",
        ],
        {
          cwd: SERVER_DIR,
          env: {
            ...process.env,
            QINGAGENT_LOG_DIR: logDir,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      await waitForStartup(child, 500);
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
});
