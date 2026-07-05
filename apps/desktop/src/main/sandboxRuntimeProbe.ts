import { app } from "electron";
import { spawnSync } from "node:child_process";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BUILTIN_SKILLS_DIR,
  SANDBOX_BIN_DIR,
  buildSandboxEnv,
  getQingagentSessionWorkspace,
  redactProbe,
  resolveIsolation,
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
  };
}

export async function runSandboxRuntimeProbe() {
  const dataDir = process.env.QINGAGENT_DATA_DIR ?? path.join(app.getPath("userData"), "data");
  const probesDir = path.join(dataDir, "probes");
  const resourcesSkillsDir = path.join(process.resourcesPath, "skills");
  const skillsDir = process.env.QINGAGENT_SKILLS_DIR ?? BUILTIN_SKILLS_DIR;
  const calcScript = path.join(skillsDir, "capability", "doc-calc", "scripts", "calc.mjs");
  const sandboxEnv = buildSandboxEnv();
  const pathHead = sandboxEnv.PATH?.split(path.delimiter)[0] ?? "";
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
