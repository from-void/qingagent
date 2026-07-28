import { describe, expect, it, vi } from "vitest";
import { seedPresetCredentialGrants } from "../skills/presetCredentialGrants.js";

vi.mock("../skills/credentialRequests.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skills/credentialRequests.js")>();
  return {
    ...actual,
    listCredentialRequests: async () => [
      {
        skillName: "feishu",
        skillLabel: "连飞书",
        declared: "~/.lark-cli",
        path: "/home/tester/.lark-cli",
      },
    ],
    ensureCredentialPathExists: async () => undefined,
  };
});

const HOME = "/home/tester";

describe("随包工具的预置授权", () => {
  it("为已被启用技能声明的路径预置授权", async () => {
    const createGrant = vi.fn(async () => undefined);
    const result = await seedPresetCredentialGrants({
      home: HOME,
      createGrant,
      raw: "~/.lark-cli",
    });
    expect(result).toEqual({ seeded: ["/home/tester/.lark-cli"], skipped: [] });
    expect(createGrant).toHaveBeenCalledWith({
      path: "/home/tester/.lark-cli",
      skillName: "feishu",
      declared: "~/.lark-cli",
      source: "preset",
    });
  });

  it("没有技能声明的路径不预置", async () => {
    const createGrant = vi.fn(async () => undefined);
    const result = await seedPresetCredentialGrants({ home: HOME, createGrant, raw: "~/.ssh" });
    expect(result).toEqual({ seeded: [], skipped: ["~/.ssh"] });
    expect(createGrant).not.toHaveBeenCalled();
  });

  it("非法写法直接跳过,不会绕过校验", async () => {
    const createGrant = vi.fn(async () => undefined);
    const result = await seedPresetCredentialGrants({
      home: HOME,
      createGrant,
      raw: "~/../etc,~/Library/Keychains",
    });
    expect(result.seeded).toEqual([]);
    expect(result.skipped).toEqual(["~/../etc", "~/Library/Keychains"]);
    expect(createGrant).not.toHaveBeenCalled();
  });

  it("未设置时不做任何事", async () => {
    const createGrant = vi.fn(async () => undefined);
    expect(await seedPresetCredentialGrants({ home: HOME, createGrant, raw: "" }))
      .toEqual({ seeded: [], skipped: [] });
    expect(createGrant).not.toHaveBeenCalled();
  });
});
