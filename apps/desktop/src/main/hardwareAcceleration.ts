export const HARDWARE_ACCELERATION_CONFIG_KEY = "qingagent.hardware_acceleration";

export type RenderingMode =
  | { mode: "hardware"; reason: "default" | "user-enabled" }
  | { mode: "software"; reason: "linux" | "unc-path" | "user-disabled" };

export interface HardwareAccelerationStartupOptions {
  platform: NodeJS.Platform;
  runningFromUncPath: boolean;
  configuredValue: string | undefined;
}

/**
 * 解析下一次启动的渲染模式。缺省值保持硬件加速开启；Linux/UNC 的既有强制关闭
 * 优先于用户偏好，避免这些环境恢复 GPU 子进程崩溃。
 */
export function resolveHardwareAccelerationMode(
  options: HardwareAccelerationStartupOptions,
): RenderingMode {
  if (options.platform === "linux") return { mode: "software", reason: "linux" };
  if (options.runningFromUncPath) return { mode: "software", reason: "unc-path" };
  if (options.configuredValue === "false") {
    return { mode: "software", reason: "user-disabled" };
  }
  return {
    mode: "hardware",
    reason: options.configuredValue === "true" ? "user-enabled" : "default",
  };
}
