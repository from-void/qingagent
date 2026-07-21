import {
  LocalSandbox,
  type CommandResult,
  type ExecuteCommandOptions,
  type LocalSandboxOptions,
  type MountResult,
  type NativeSandboxConfig,
  type WorkspaceFilesystem,
} from "@mastra/core/workspace";
import { createHash } from "node:crypto";
import {
  prepareBubblewrapReadWallPolicy,
  validateBubblewrapArgsContract,
} from "./readWallBubblewrap.js";
import type { ReadWallProcessRunner } from "./readWallProcess.js";
import { resolveReadWallPolicy, type ReadWallPlatform } from "./readWallPolicy.js";
import { prepareSeatbeltReadWallPolicy, verifySeatbeltProfileHash } from "./readWallSeatbelt.js";

export interface PrepareReadWallOptions {
  platform: ReadWallPlatform;
  /** 宿主策略解析 env；只在宿主进程内读取，不整包透传给探针子进程。 */
  env: NodeJS.ProcessEnv;
  /** 已按 LocalSandbox 白名单收窄的探针/命令 env。 */
  sandboxEnv: NodeJS.ProcessEnv;
  dataDir: string;
  sessionDir: string;
  sandboxBinDir: string;
  builtinSkillsDir: string;
  userSkillsDir: string;
  extraReadOnlyPaths: string[];
  nodeExecutable: string;
  runner?: ReadWallProcessRunner;
  effectiveUid?: number;
  effectiveHome?: string;
}

export interface PreparedReadWall {
  nativeSandbox: NativeSandboxConfig;
  effectiveHome: string;
  policyHash: string;
  ruleCount: number;
  warnings: string[];
  mode: "seatbelt" | "bwrap-read-wall" | "bwrap-strict-fallback";
  verifyIntegrity: () => Promise<void>;
}

export async function prepareReadWall(options: PrepareReadWallOptions): Promise<PreparedReadWall> {
  const policy = await resolveReadWallPolicy({
    platform: options.platform,
    env: options.env,
    dataDir: options.dataDir,
    sessionDir: options.sessionDir,
    sandboxBinDir: options.sandboxBinDir,
    builtinSkillsDir: options.builtinSkillsDir,
    userSkillsDir: options.userSkillsDir,
    extraReadOnlyPaths: options.extraReadOnlyPaths,
    effectiveUid: options.effectiveUid,
    effectiveHome: options.effectiveHome,
  });
  const readOnlyPaths = policy.allowPaths.filter((path) => !path.writable).map((path) => path.lexicalPath);
  const readWritePaths = policy.allowPaths.filter((path) => path.writable).map((path) => path.lexicalPath);
  const sandboxEnv = { ...options.sandboxEnv, HOME: policy.effectiveHome };

  if (options.platform === "darwin") {
    const seatbelt = await prepareSeatbeltReadWallPolicy({
      policy,
      dataDir: options.dataDir,
      env: sandboxEnv,
      runner: options.runner,
    });
    return {
      nativeSandbox: {
        allowNetwork: true,
        readOnlyPaths,
        readWritePaths,
        seatbeltProfilePath: seatbelt.profilePath,
      },
      effectiveHome: policy.effectiveHome,
      policyHash: policy.hash,
      ruleCount: policy.credentialDenyPaths.length + 1,
      warnings: policy.warnings,
      mode: "seatbelt",
      verifyIntegrity: () => verifySeatbeltProfileHash(seatbelt.profilePath, seatbelt.profileHash),
    };
  }

  const bubblewrap = await prepareBubblewrapReadWallPolicy({
    policy,
    env: sandboxEnv,
    nodeExecutable: options.nodeExecutable,
    runner: options.runner,
  });
  validateBubblewrapArgsContract(bubblewrap.args, bubblewrap.mode === "read-wall");
  const expectedArgsHash = createHash("sha256").update(JSON.stringify(bubblewrap.args)).digest("hex");
  return {
    nativeSandbox: {
      allowNetwork: true,
      readOnlyPaths,
      readWritePaths,
      bwrapArgs: bubblewrap.args,
    },
    effectiveHome: policy.effectiveHome,
    policyHash: policy.hash,
    ruleCount: policy.credentialDenyPaths.length + 1,
    warnings: policy.warnings,
    mode: bubblewrap.mode === "read-wall" ? "bwrap-read-wall" : "bwrap-strict-fallback",
    verifyIntegrity: async () => {
      const actualHash = createHash("sha256").update(JSON.stringify(bubblewrap.args)).digest("hex");
      if (actualHash !== expectedArgsHash) throw new Error("bubblewrap policy arguments changed after preflight");
      validateBubblewrapArgsContract(bubblewrap.args, bubblewrap.mode === "read-wall");
    },
  };
}

export interface ReadWallLocalSandboxOptions extends LocalSandboxOptions {
  verifyReadWallIntegrity: () => Promise<void>;
}

function isIsolationRuntimeFailure(result: CommandResult): boolean {
  if (result.exitCode === 0) return false;
  const stderr = result.stderr.trimStart();
  return /(^|\n)(bwrap|sandbox-exec):/.test(stderr);
}

/**
 * LocalSandbox 的安全包装：禁止动态 mount 覆盖读墙；每条命令前复核策略完整性；
 * 运行期隔离器故障后永久熔断本 Workspace，绝不无沙箱重试。
 */
export class ReadWallLocalSandbox extends LocalSandbox {
  private readWallHealthy = true;
  private readonly verifyReadWallIntegrity: () => Promise<void>;

  constructor(options: ReadWallLocalSandboxOptions) {
    const { verifyReadWallIntegrity, ...sandboxOptions } = options;
    super(sandboxOptions);
    this.verifyReadWallIntegrity = verifyReadWallIntegrity;
    const execute = this.executeCommand?.bind(this);
    if (!execute) throw new Error("LocalSandbox does not expose executeCommand");
    this.executeCommand = async (
      command: string,
      args?: string[],
      executeOptions?: ExecuteCommandOptions,
    ): Promise<CommandResult> => {
      this.assertReadWallHealthy();
      try {
        await this.verifyReadWallIntegrity();
        const result = await execute(command, args, executeOptions);
        if (isIsolationRuntimeFailure(result)) this.markReadWallUnhealthy();
        return result;
      } catch (error) {
        this.markReadWallUnhealthy();
        throw error;
      }
    };
  }

  override async start(): Promise<void> {
    this.assertReadWallHealthy();
    await this.verifyReadWallIntegrity();
    await super.start();
    await this.verifyReadWallIntegrity();
  }

  override async mount(_filesystem: WorkspaceFilesystem, _mountPath: string): Promise<MountResult> {
    this.markReadWallUnhealthy();
    throw new Error("read-wall forbids sandbox.mount(); re-audit Mastra before adding dynamic mounts");
  }

  isReadWallHealthy(): boolean {
    return this.readWallHealthy;
  }

  private assertReadWallHealthy(): void {
    if (!this.readWallHealthy) throw new Error("read-wall is unhealthy; commands are disabled for this Workspace");
  }

  private markReadWallUnhealthy(): void {
    this.readWallHealthy = false;
    this.status = "error";
  }
}
