import { describe, expect, it } from "vitest";
import {
  ATTACH_CAPABILITY_NAMES,
  ATTACH_MODEL_OVERRIDE_HEADERS,
  ATTACH_MUST_ENABLE_CAPABILITIES,
  ATTACH_PROTOCOL_VERSION,
} from "../Attach";

describe("attach 手维护契约", () => {
  it("协议版本与 17 项 capability 唯一枚举固定", () => {
    expect(ATTACH_PROTOCOL_VERSION).toBe(1);
    expect(ATTACH_CAPABILITY_NAMES).toEqual([
      "folderSelection", "confirmGrant", "diagnosticsExport", "documentExport", "sessionDeletion",
      "credentialProvider", "modelKeys", "skillMutation", "connectors", "updates",
      "templateMutation", "derivativeMutation", "lexiconMutation", "deepLink",
      "docEditing", "review", "assets",
    ]);
    expect(new Set(ATTACH_CAPABILITY_NAMES).size).toBe(ATTACH_CAPABILITY_NAMES.length);
    expect(ATTACH_MUST_ENABLE_CAPABILITIES).toEqual([
      "docEditing", "review", "assets", "deepLink",
    ]);
  });

  it("模型覆盖 header 清单唯一包含 vision source 三选一信号", () => {
    expect(ATTACH_MODEL_OVERRIDE_HEADERS).toEqual([
      "x-model-provider",
      "x-model-key",
      "x-model-base-url",
      "x-model-flash",
      "x-model-pro",
      "x-model-tier",
      "x-model-protocol",
      "x-vision-source",
      "x-vision-key",
      "x-vision-base-url",
      "x-vision-model",
      "x-vision-protocol",
    ]);
    expect(new Set(ATTACH_MODEL_OVERRIDE_HEADERS).size).toBe(
      ATTACH_MODEL_OVERRIDE_HEADERS.length,
    );
  });
});
