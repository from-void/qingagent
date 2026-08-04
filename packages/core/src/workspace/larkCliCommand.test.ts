import { describe, expect, it } from "vitest";
import { parseLarkCliCommandPath } from "./larkCliCommand.js";

describe("parseLarkCliCommandPath", () => {
  it.each([
    [["--json", "auth", "logout"], ["auth", "logout"]],
    [["--verbose", "im", "send", "--chat", "x"], ["im", "send"]],
    [["--profile", "sandbox", "auth", "logout"], ["auth", "logout"]],
    [["--profile=sandbox", "auth", "logout"], ["auth", "logout"]],
    [["--future=value", "im", "list"], ["im", "list"]],
    [["--", "auth", "logout"], ["auth", "logout"]],
  ])("确定性跳过前置全局 flag：%j", (args, commandPath) => {
    expect(parseLarkCliCommandPath(args)).toEqual({
      ok: true,
      commandPath,
    });
  });

  it.each([
    ["未知 flag 可能吞掉后续值", ["--foo", "bar", "auth", "logout"]],
    ["已知带值 flag 缺值", ["--profile"]],
    ["已知带值 flag 后紧跟另一 flag", ["--profile", "--json", "auth", "logout"]],
    ["未知短 flag", ["-x", "auth", "logout"]],
  ])("%s 时返回歧义而不猜子命令", (_label, args) => {
    expect(parseLarkCliCommandPath(args)).toMatchObject({
      ok: false,
      reason: expect.any(String),
    });
  });

  it("子命令路径确定后不再剥离位置参数或子命令 flag", () => {
    expect(parseLarkCliCommandPath(["im", "list", "--foo", "bar"])).toEqual({
      ok: true,
      commandPath: ["im", "list"],
    });
    expect(parseLarkCliCommandPath(["docs", "+get", "--title", "create"])).toEqual({
      ok: true,
      commandPath: ["docs", "+get"],
    });
    expect(parseLarkCliCommandPath(["im", "list", "create"])).toEqual({
      ok: true,
      commandPath: ["im", "list"],
    });
    expect(parseLarkCliCommandPath(["base", "record", "create", "--field", "update"])).toEqual({
      ok: true,
      commandPath: ["base", "record", "create"],
    });
  });
});
