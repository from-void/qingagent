import { app } from "electron";
import { spawnSync } from "node:child_process";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SANDBOX_BIN_DIR,
  SANDBOX_NODE_RUNTIME_DIR,
  builtinSkillsDir,
  buildSandboxEnv,
  getQingagentSessionWorkspace,
  redactProbe,
  resolveIsolation,
  resolveNodeRuntimePathPlacement,
} from "@qingagent/core";

export { redactProbe };

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function listDir(target: string): Promise<string[]> {
  try {
    return await readdir(target);
  } catch {
    return [];
  }
}

function spawnElectronAsNode() {
  const result = spawnSync(process.execPath, ["-p", "process.versions.node"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error?.message,
  };
}

async function sandboxNodeProbe(sessionId: string) {
  const workspace = await getQingagentSessionWorkspace(sessionId);
  await workspace.init?.();
  const skills = (await workspace.skills?.list()) ?? [];
  const sandbox = workspace.sandbox;
  const command = sandbox?.executeCommand
    ? await sandbox.executeCommand("node", [
        "-p",
        "JSON.stringify({node:process.version,exec:process.execPath})",
      ], { timeout: 10_000 })
    : null;
  // 沙箱里 `node` 到底解析到谁:这是"宿主 CLI 会被谁拉起"的第一手事实,
  // 真机验收(command -v node / process.execPath)靠它一次看清,不必猜。
  const nodeWhich = sandbox?.executeCommand && process.platform !== "win32"
    ? await sandbox.executeCommand("sh", ["-c", "command -v node || true"], { timeout: 10_000 })
    : null;
  return {
    skills: skills.map((skill) => skill.name),
    nodeCommand: command
      ? {
          exitCode: command.exitCode,
          success: command.success,
          stdout: command.stdout.trim(),
          stderr: command.stderr.trim(),
        }
      : null,
    nodeResolvedPath: nodeWhich ? nodeWhich.stdout.trim() : null,
  };
}

export async function runSandboxRuntimeProbe() {
  const dataDir = process.env.QINGAGENT_DATA_DIR ?? path.join(app.getPath("userData"), "data");
  const probesDir = path.join(dataDir, "probes");
  const resourcesSkillsDir = path.join(process.resourcesPath, "skills");
  const skillsDir = builtinSkillsDir();
  const calcScript = path.join(skillsDir, "capability", "doc-calc", "scripts", "calc.mjs");
  const sandboxEnv = buildSandboxEnv();
  const pathEntries = (sandboxEnv.PATH ?? "").split(path.delimiter).filter(Boolean);
  const pathHead = pathEntries[0] ?? "";
  const sessionId = `runtime-probe-${Date.now()}`;

  const electronAsNode = spawnElectronAsNode();
  let workspaceFacts: Awaited<ReturnType<typeof sandboxNodeProbe>> | { error: string };
  try {
    workspaceFacts = await sandboxNodeProbe(sessionId);
  } catch (error) {
    workspaceFacts = { error: error instanceof Error ? error.message : String(error) };
  }

  const raw = {
    ok: false,
    writtenAt: new Date().toISOString(),
    main: {
      isPackaged: app.isPackaged,
      platform: process.platform,
      versions: {
        node: process.versions.node,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
      },
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
      nodeRuntime: process.env.QINGAGENT_SANDBOX_NODE_RUNTIME === "system"
        ? "system (HOST NODE - diagnostic only)"
        : "auto",
      env: {
        QINGAGENT_DATA_DIR: dataDir,
        QINGAGENT_SKILLS_DIR: skillsDir,
        QINGAGENT_USER_SKILLS_DIR: process.env.QINGAGENT_USER_SKILLS_DIR,
        QINGAGENT_SANDBOX_EXTRA_READONLY_PATHS: process.env.QINGAGENT_SANDBOX_EXTRA_READONLY_PATHS,
      },
    },
    core: {
      isolation: resolveIsolation(),
      sandboxBinDir: SANDBOX_BIN_DIR,
      sandboxBinEntries: await listDir(SANDBOX_BIN_DIR),
      sandboxEnvPathStartsWithBin: pathHead === SANDBOX_BIN_DIR,
      // Node 运行时站位:host-first 表示宿主自己的 Node 优先,产品运行时只在 PATH 末尾兜底。
      nodeRuntimePlacement: resolveNodeRuntimePathPlacement(),
      nodeRuntimeDir: SANDBOX_NODE_RUNTIME_DIR,
      nodeRuntimeEntries: await listDir(SANDBOX_NODE_RUNTIME_DIR),
      // 只报站位不报原文:PATH 里含宿主用户名与个人目录,探针文件可能被外发。
      nodeRuntimeDirPathIndex: pathEntries.indexOf(SANDBOX_NODE_RUNTIME_DIR),
      pathEntryCount: pathEntries.length,
      resourcesSkillsExists: await exists(resourcesSkillsDir),
      calcScriptExists: await exists(calcScript),
    },
    electronAsNode,
    workspace: workspaceFacts,
  };

  raw.ok = electronAsNode.status === 0 &&
    raw.core.sandboxEnvPathStartsWithBin &&
    raw.core.calcScriptExists &&
    "nodeCommand" in workspaceFacts &&
    workspaceFacts.nodeCommand?.exitCode === 0 &&
    workspaceFacts.skills.includes("doc-calc") &&
    workspaceFacts.skills.includes("feishu");

  const redacted = redactProbe(raw, {
    dataDir,
    resourcesPath: process.resourcesPath,
    sandboxBinDir: SANDBOX_BIN_DIR,
    execDir: path.dirname(process.execPath),
  });
  await mkdir(probesDir, { recursive: true });
  const outPath = path.join(probesDir, `sandbox-runtime-${process.platform}-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify(redacted, null, 2), "utf8");
  return { ok: raw.ok, path: outPath, probe: redacted };
}
