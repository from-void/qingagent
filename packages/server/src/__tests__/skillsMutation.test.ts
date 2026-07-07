import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSkillFrontmatter } from "../routes/skills";

// 技能 mutation 开关:仅 QINGAGENT_ALLOW_SKILL_MUTATION 显式真值时放行安装/删除,启停始终放行。

async function loadApp() {
  const { Hono } = await import("hono");
  // 动态 import 以读取当前 env(开关是运行时读取,无需重置模块)
  const { skillsRoutes } = await import("../routes/skills");
  const app = new Hono();
  app.route("/api/v1", skillsRoutes);
  return app;
}

describe("技能 mutation 开关", () => {
  const installedNames = new Set<string>();

  afterEach(async () => {
    delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
    if (installedNames.size > 0) {
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { SKILLS_INSTALL_DIR } = await import("@qingagent/core");
      await Promise.all(
        Array.from(installedNames, (name) =>
          rm(join(SKILLS_INSTALL_DIR, name), { recursive: true, force: true }).catch(() => undefined),
        ),
      );
      installedNames.clear();
    }
  });

  it("默认(未设)禁止安装——返回 403", async () => {
    delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
    const app = await loadApp();
    const res = await app.request("/api/v1/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", skillMd: "---\nname: x\ndescription: y\n---\n" }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("禁止安装");
  });

  it("显式 =1 允许安装——不被开关拦(走到正常处理)", async () => {
    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "1";
    const skillName = "gate-explicit-one";
    const app = await loadApp();
    const res = await app.request("/api/v1/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: skillName,
        skillMd: `---\nname: ${skillName}\ndescription: y\n---\n`,
      }),
    });
    if (res.status === 200) installedNames.add(skillName);
    // 不是 403(开关没拦);具体成功/失败由安装逻辑决定,这里只验开关未拦。
    expect(res.status).not.toBe(403);
  });

  it("关闭时安装返回 403", async () => {
    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "0";
    const app = await loadApp();
    const res = await app.request("/api/v1/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", skillMd: "..." }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("禁止安装");
  });

  it("关闭时删除返回 403", async () => {
    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "0";
    const app = await loadApp();
    const res = await app.request("/api/v1/skills/some-skill", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("禁止删除");
  });

  it("关闭时启用/禁用仍放行(不被开关拦)", async () => {
    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "0";
    const app = await loadApp();
    const res = await app.request("/api/v1/skills/nonexistent/enable", { method: "POST" });
    // 不是 403(启停不受 mutation 开关影响);技能不存在会 404,但不是开关拦的
    expect(res.status).not.toBe(403);
  });

  // 安全:开关只判 !=='0' 会把 =false/=off 当成开启 → 误以为关了其实没关。
  it.each(["false", "FALSE", "off", "no", " 0 "])(
    "falsy 取值 %j 也视为关闭,安装返回 403",
    async (value) => {
      process.env.QINGAGENT_ALLOW_SKILL_MUTATION = value;
      const app = await loadApp();
      const res = await app.request("/api/v1/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", skillMd: "..." }),
      });
      expect(res.status).toBe(403);
    },
  );

  it.each([
    ["1", "gate-truthy-one"],
    ["true", "gate-truthy-true"],
    ["YES", "gate-truthy-yes"],
    ["on", "gate-truthy-on"],
  ])("真值取值 %j 视为开启,安装不被开关拦", async (value, skillName) => {
    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = value;
    const app = await loadApp();
    const res = await app.request("/api/v1/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: skillName,
        skillMd: `---\nname: ${skillName}\ndescription: y\n---\n`,
      }),
    });
    if (res.status === 200) installedNames.add(skillName);
    expect(res.status).not.toBe(403);
  });
});

// 安装走 SKILL.md 单一真源:前端不传 name,后端从 frontmatter 取名;并容忍 UTF-8 BOM。
describe("技能安装——name 单一真源 + BOM 容忍", () => {
  const SKILL = "rev-bom-demo";
  let installDir = "";

  beforeEach(async () => {
    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "1";
    const { mkdir } = await import("node:fs/promises");
    const { SKILLS_INSTALL_DIR } = await import("@qingagent/core");
    await mkdir(SKILLS_INSTALL_DIR, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
    if (installDir) {
      const { rm } = await import("node:fs/promises");
      await rm(installDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("仅传 skillMd(无 name)、且带 BOM,后端解析 frontmatter 取名并安装成功", async () => {
    const { SKILLS_INSTALL_DIR } = await import("@qingagent/core");
    const { join } = await import("node:path");
    installDir = join(SKILLS_INSTALL_DIR, SKILL);
    const app = await loadApp();
    // 前导 ﻿ 模拟 Windows 记事本导出的 BOM;body 不含 name。
    const skillMd = `﻿---\nname: ${SKILL}\ndescription: 演示\n---\n# demo`;
    const res = await app.request("/api/v1/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillMd }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ installed: true, name: SKILL });
  });

  it("归档内置技能名仍是保留名,不能导入同名自装技能", async () => {
    const app = await loadApp();
    const res = await app.request("/api/v1/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillMd: "---\nname: dingtalk-docs\ndescription: 演示\n---\n# demo",
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "这个技能已存在" });
  });
});

describe("技能导入 UX 元数据", () => {
  const installedNames = new Set<string>();

  beforeEach(async () => {
    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "1";
    const { mkdir } = await import("node:fs/promises");
    const { SKILLS_INSTALL_DIR } = await import("@qingagent/core");
    await mkdir(SKILLS_INSTALL_DIR, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
    if (installedNames.size > 0) {
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { SKILLS_INSTALL_DIR } = await import("@qingagent/core");
      await Promise.all(
        Array.from(installedNames, (name) =>
          rm(join(SKILLS_INSTALL_DIR, name), { recursive: true, force: true }).catch(() => undefined),
        ),
      );
      installedNames.clear();
    }
  });

  it("PATCH /skills/:name 只改显示名 label，不改 slug，且不截断长中文", async () => {
    const app = await loadApp();
    const skillName = "rename-label-demo";
    const skillMd = `---\nname: ${skillName}\ndescription: 演示\nlabel: 旧名\nuser-invocable: true\n---\n# demo`;
    const install = await app.request("/api/v1/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillMd }),
    });
    expect(install.status).toBe(200);
    installedNames.add(skillName);

    const longLabel = "这是一个很长很长的中文显示名用于确认保存后不会被静默截断并且底层标识保持稳定";
    const rename = await app.request(`/api/v1/skills/${skillName}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: longLabel }),
    });

    expect(rename.status).toBe(200);
    expect(await rename.json()).toEqual({ name: skillName, label: longLabel });

    const detail = await app.request(`/api/v1/skills/${skillName}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      name: skillName,
      label: longLabel,
    });

    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { SKILLS_INSTALL_DIR } = await import("@qingagent/core");
    const saved = await readFile(join(SKILLS_INSTALL_DIR, skillName, "SKILL.md"), "utf8");
    expect(saved).toContain(`name: ${skillName}`);
    expect(parseSkillFrontmatter(saved)?.label).toBe(longLabel);
  });

  it("安装技能缺省 user-invocable 时按已安装技能默认可插入，显式 false 仍不进菜单", async () => {
    const app = await loadApp();
    const defaultInvocable = "default-invocable-demo";
    const explicitFalse = "explicit-hidden-demo";
    for (const skillMd of [
      `---\nname: ${defaultInvocable}\ndescription: 演示\nlabel: 默认可用\n---\n# demo`,
      `---\nname: ${explicitFalse}\ndescription: 演示\nlabel: 显式隐藏\nuser-invocable: false\n---\n# demo`,
    ]) {
      const res = await app.request("/api/v1/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillMd }),
      });
      expect(res.status).toBe(200);
    }
    installedNames.add(defaultInvocable);
    installedNames.add(explicitFalse);

    const res = await app.request("/api/v1/skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ name: string; userInvocable: boolean; enabled: boolean }> };
    const defaultSkill = body.skills.find((skill) => skill.name === defaultInvocable);
    const hiddenSkill = body.skills.find((skill) => skill.name === explicitFalse);
    expect(defaultSkill).toMatchObject({ userInvocable: true, enabled: true });
    expect(hiddenSkill).toMatchObject({ userInvocable: false, enabled: true });
  });
});

describe("parseSkillFrontmatter 扩展字段脏路径", () => {
  it("解析完整字段、引号/无引号、内联 tools 数组和额外字段", () => {
    const parsed = parseSkillFrontmatter(`---
name: quoted-demo
label: "短名"
summary: '一句话简介'
icon: search
description: "用于测试的技能描述。后面还有第二句"
user-invocable: true
placeholder: 搜索主题
config: search-provider
tools: [webSearch, browser_*, run_js]
extra-field: ignored
metadata:
  category: capability
---
# body`);

    expect(parsed).toMatchObject({
      name: "quoted-demo",
      label: "短名",
      summary: "一句话简介",
      icon: "search",
      description: "用于测试的技能描述。后面还有第二句",
      userInvocable: true,
      placeholder: "搜索主题",
      config: "search-provider",
      tools: ["webSearch", "browser_*", "run_js"],
    });
  });

  it("缺展示字段时兜底，user-invocable 缺省 false", () => {
    const parsed = parseSkillFrontmatter(`---
name: fallback-demo-skill
description: 第一段摘要，后面不应进入摘要。第二句
---
# body`);

    expect(parsed).toMatchObject({
      name: "fallback-demo-skill",
      label: "fallback-demo-skill",
      summary: "第一段摘要",
      icon: "star",
      userInvocable: false,
      tools: [],
    });
  });

  it("支持 BOM、CRLF 和缩进列表 tools", () => {
    const parsed = parseSkillFrontmatter(
      "\uFEFF---\r\nname: crlf-demo\r\nlabel: 看图片\r\nsummary: 识别图片内容与文字\r\nicon: vision\r\ndescription: 描述\r\nuser-invocable: false\r\ntools:\r\n  - readImage\r\n  - browser_*\r\n---\r\n# body",
    );

    expect(parsed).toMatchObject({
      name: "crlf-demo",
      label: "看图片",
      summary: "识别图片内容与文字",
      icon: "vision",
      userInvocable: false,
      tools: ["readImage", "browser_*"],
    });
  });

  it.each(["True", '"true"', "'true'"])(
    "兼容 user-invocable 的 YAML 布尔写法 %s",
    (value) => {
      const parsed = parseSkillFrontmatter(`---
name: bool-demo
description: 描述
user-invocable: ${value}
---
# body`);

      expect(parsed?.userInvocable).toBe(true);
    },
  );
});
