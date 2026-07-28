import {
  LocalSandbox,
  type CommandResult,
  type ExecuteCommandOptions,
  type LocalSandboxOptions,
  type MountResult,
  type NativeSandboxConfig,
  type ProcessHandle,
  type SpawnProcessOptions,
  type WorkspaceFilesystem,
} from "@mastra/core/workspace";
import { createHash } from "node:crypto";
import {
  prepareBubblewrapReadWallPolicy,
  validateBubblewrapArgsContract,
} from "./readWallBubblewrap.js";
import type { ReadWallProcessRunner } from "./readWallProcess.js";
import {
  resolveReadWallPolicy,
  type CredentialWallMode,
  type ReadWallPlatform,
} from "./readWallPolicy.js";
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
  /** 已授权可与终端共享的凭证路径(绝对路径)。 */
  grantedCredentialPaths?: string[];
  credentialWallMode?: CredentialWallMode;
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
  /** 本次实际生效的凭证共享路径,用于日志与自检。 */
  credentialPaths: string[];
  credentialWallMode: CredentialWallMode;
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
    grantedCredentialPaths: options.grantedCredentialPaths,
    credentialWallMode: options.credentialWallMode,
    effectiveUid: options.effectiveUid,
    effectiveHome: options.effectiveHome,
  });
  const readOnlyPaths = policy.allowPaths.filter((path) => !path.writable).map((path) => path.lexicalPath);
  const readWritePaths = policy.allowPaths.filter((path) => path.writable).map((path) => path.lexicalPath);
  const credentialPaths = policy.allowPaths
    .filter((path) => path.kind === "credential")
    .map((path) => path.lexicalPath);
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
      credentialPaths,
      credentialWallMode: policy.credentialWallMode,
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
    credentialPaths,
    credentialWallMode: policy.credentialWallMode,
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

function shellQuoteCommandArg(arg: string): string {
  if (/^[a-zA-Z0-9._\-/=:@]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * LocalSandbox 的安全包装：禁止动态 mount 覆盖读墙；每条命令前复核策略完整性；
 * 运行期隔离器故障后永久熔断本 Workspace，绝不无沙箱重试。
 */
export class ReadWallLocalSandbox extends LocalSandbox {
  private readWallHealthy = true;
  private processStartTail: Promise<void> = Promise.resolve();
  private readonly verifyReadWallIntegrity: () => Promise<void>;

  constructor(options: ReadWallLocalSandboxOptions) {
    const { verifyReadWallIntegrity, ...sandboxOptions } = options;
    super(sandboxOptions);
    this.verifyReadWallIntegrity = verifyReadWallIntegrity;
    const spawnProcess = this.processes.spawn.bind(this.processes);
    this.processes.spawn = async (
      command: string,
      spawnOptions?: SpawnProcessOptions,
    ): Promise<ProcessHandle> => {
      return this.serializeProcessStart(async () => {
        this.assertReadWallHealthy();
        try {
          await this.verifyReadWallIntegrity();
        } catch (error) {
          this.markReadWallUnhealthy();
          throw error;
        }
        try {
          return await spawnProcess(command, spawnOptions);
        } catch (error) {
          this.markReadWallUnhealthy();
          throw error;
        }
      });
    };
    this.executeCommand = async (
      command: string,
      args?: string[],
      executeOptions?: ExecuteCommandOptions,
    ): Promise<CommandResult> => {
      this.assertReadWallHealthy();

      const fullCommand = args?.length
        ? `${command} ${args.map(shellQuoteCommandArg).join(" ")}`
        : command;
      let handle;
      try {
        // spawn 返回即表示隔离器已完成启动阶段；只有此前的结构化启动/拉起失败才熔断。
        handle = await this.processes.spawn(fullCommand, {
          ...executeOptions,
          maxRetainedBytes: executeOptions?.maxRetainedBytes ?? Infinity,
        });
      } catch (error) {
        this.markReadWallUnhealthy();
        throw error;
      }
      const result = await handle.wait();
      return { ...result, command: fullCommand };
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

  private async serializeProcessStart<T>(startProcess: () => Promise<T>): Promise<T> {
    const previousStart = this.processStartTail;
    let releaseStart!: () => void;
    this.processStartTail = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    await previousStart;
    try {
      return await startProcess();
    } finally {
      releaseStart();
    }
  }

  private markReadWallUnhealthy(): void {
    this.readWallHealthy = false;
    this.status = "error";
  }
}
