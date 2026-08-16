import { beforeEach, describe, expect, it, vi } from "vitest";

describe("attach renderer 能力真源", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("只读取主进程 IPC 注入的 effectiveCapabilities", async () => {
    vi.stubGlobal("window", {
      electron: {
        getBackendConnection: () => ({
          mode: "attach",
          status: "attached",
          generation: 0,
          libraryId: "00000000-0000-4000-8000-000000000001",
          instanceId: "00000000-0000-4000-8000-000000000002",
          effectiveCapabilities: {
            docEditing: true,
            derivativeMutation: false,
          },
          errorCode: null,
          conflictKind: null,
        }),
      },
    });
    const { attachCapabilityEnabled } = await import("./backendConnectionStore");
    expect(attachCapabilityEnabled("docEditing")).toBe(true);
    expect(attachCapabilityEnabled("derivativeMutation")).toBe(false);
    expect(attachCapabilityEnabled("unknownCapability")).toBe(false);
    vi.unstubAllGlobals();
  });
});
