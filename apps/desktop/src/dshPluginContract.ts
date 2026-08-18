export const DSH_PLUGIN_DETECT_CHANNEL = "qingagent:dsh-plugin-detect";
export const DSH_PLUGIN_INSTALL_CHANNEL = "qingagent:dsh-plugin-install";

export interface DshProfileSnapshot {
  name: string;
  bundles: string[];
  pluginVersion: string | null;
}

export interface DshDetectionSnapshot {
  detected: boolean;
  profiles: DshProfileSnapshot[];
  defaultProfile: string | null;
  npxAvailable: boolean;
}

export type DshInstallFailureReason =
  | "already-running"
  | "invalid-profile"
  | "npx-not-found"
  | "spawn-failed"
  | "timed-out"
  | "exit-failed";

export type DshInstallResult =
  | {
      ok: true;
      profile: string;
      command: string;
      output: string;
    }
  | {
      ok: false;
      profile: string;
      command: string;
      reason: DshInstallFailureReason;
      stderr: string;
      output: string;
    };
