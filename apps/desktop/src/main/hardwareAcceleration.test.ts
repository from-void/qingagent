import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveHardwareAccelerationMode,
} from "./hardwareAcceleration.js";

describe("hardware acceleration startup policy", () => {
  it("配置缺失时默认开启硬件加速", () => {
    assert.deepEqual(
      resolveHardwareAccelerationMode({
        platform: "win32",
        runningFromUncPath: false,
        configuredValue: undefined,
      }),
      { mode: "hardware", reason: "default" },
    );
  });

  it("用户关闭后重启走软件渲染", () => {
    assert.deepEqual(
      resolveHardwareAccelerationMode({
        platform: "win32",
        runningFromUncPath: false,
        configuredValue: "false",
      }),
      { mode: "software", reason: "user-disabled" },
    );
  });

  it("用户重新开启后重启恢复硬件加速", () => {
    assert.deepEqual(
      resolveHardwareAccelerationMode({
        platform: "win32",
        runningFromUncPath: false,
        configuredValue: "true",
      }),
      { mode: "hardware", reason: "user-enabled" },
    );
  });

  it("Linux 与 WSL/UNC 仍强制走软件渲染", () => {
    assert.deepEqual(
      resolveHardwareAccelerationMode({
        platform: "linux",
        runningFromUncPath: false,
        configuredValue: "true",
      }),
      { mode: "software", reason: "linux" },
    );
    assert.deepEqual(
      resolveHardwareAccelerationMode({
        platform: "win32",
        runningFromUncPath: true,
        configuredValue: "true",
      }),
      { mode: "software", reason: "unc-path" },
    );
  });
});
