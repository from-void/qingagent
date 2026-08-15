import { describe, expect, it } from "vitest";
import {
  ATTACH_CAPABILITY_NAMES,
  ATTACH_MUST_ENABLE_CAPABILITIES,
  ATTACH_PROTOCOL_VERSION,
} from "../Attach";

describe("attach 手维护契约", () => {
  it("协议版本与 16 项 capability 唯一枚举固定", () => {
    expect(ATTACH_PROTOCOL_VERSION).toBe(1);
    expect(ATTACH_CAPABILITY_NAMES).toEqual([
      "folderSelection", "confirmGrant", "diagnosticsExport", "documentExport",
      "credentialProvider", "modelKeys", "skillMutation", "connectors", "updates",
      "templateMutation", "derivativeMutation", "lexiconMutation", "deepLink",
      "docEditing", "review", "assets",
    ]);
    expect(new Set(ATTACH_CAPABILITY_NAMES).size).toBe(ATTACH_CAPABILITY_NAMES.length);
    expect(ATTACH_MUST_ENABLE_CAPABILITIES).toEqual([
      "docEditing", "review", "assets", "deepLink",
    ]);
  });
});
