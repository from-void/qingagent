import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { uploadsBaseDir } from "./uploadsDir.js";

// 上传根目录解析:默认 cwd/uploads;QINGAGENT_UPLOADS_DIR 覆盖(桌面端指 userData)。
// 脏形态:未设置 / 绝对 / 相对 / 两侧空白 / 纯空白。
describe("uploadsBaseDir", () => {
  const orig = process.env.QINGAGENT_UPLOADS_DIR;
  afterEach(() => {
    if (orig === undefined) delete process.env.QINGAGENT_UPLOADS_DIR;
    else process.env.QINGAGENT_UPLOADS_DIR = orig;
  });

  it("未设置时默认 cwd/uploads(web/VPS 行为不变)", () => {
    delete process.env.QINGAGENT_UPLOADS_DIR;
    expect(uploadsBaseDir()).toBe(path.resolve("./uploads"));
  });

  it("设置绝对路径(桌面 userData 形态)→ 原样 resolve", () => {
    process.env.QINGAGENT_UPLOADS_DIR = "/home/u/.config/app/uploads";
    expect(uploadsBaseDir()).toBe(path.resolve("/home/u/.config/app/uploads"));
  });

  it("相对路径也 resolve;两侧空白被 trim", () => {
    process.env.QINGAGENT_UPLOADS_DIR = "  ./customup  ";
    expect(uploadsBaseDir()).toBe(path.resolve("./customup"));
  });

  it("空字符串/纯空白视为未设置 → 回默认", () => {
    process.env.QINGAGENT_UPLOADS_DIR = "   ";
    expect(uploadsBaseDir()).toBe(path.resolve("./uploads"));
  });
});
