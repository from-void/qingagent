import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

// 测试安装目录必须留在可写临时区，不能污染/依赖运行用户的 ~/.qingagent/skills。
// hoisted 保证 paths.ts 首次求值前已注入。
const TEST_SKILLS_DIR = vi.hoisted(() => {
  const path = `/tmp/qingagent-skills-mutation-${process.pid}`;
  process.env.QINGAGENT_USER_SKILLS_DIR = path;
  return path;
});
const TEST_LEGACY_SKILLS_DIR = vi.hoisted(() => {
  const path = `/tmp/qingagent-legacy-skills-mutation-${process.pid}`;
  process.env.QINGAGENT_LEGACY_USER_SKILLS_DIRS = path;
  return path;
});
import { parseSkillFrontmatter } from "../routes/skills";

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all([
    rm(TEST_SKILLS_DIR, { recursive: true, force: true }),
    rm(TEST_LEGACY_SKILLS_DIR, { recursive: true, force: true }),
  ]);
  delete process.env.QINGAGENT_USER_SKILLS_DIR;
  delete process.env.QINGAGENT_LEGACY_USER_SKILLS_DIRS;
});

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

  it("小压缩包解出超过总上限时流式中止，且不留下半安装目录", async () => {
    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "1";
    const skillName = "zip-bomb-bounded";
    const zip = new JSZip();
    zip.file(
      "SKILL.md",
      `---\nname: ${skillName}\ndescription: 流式上限回归\n---\n# demo`,
    );
    zip.file("assets/repeated.txt", "x".repeat(10 * 1024 * 1024 + 1));
    const compressed = await zip.generateAsync({
      type: "arraybuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    expect(compressed.byteLength).toBeLessThan(256 * 1024);
    const form = new FormData();
    form.set("file", new File([compressed], "skill.zip", { type: "application/zip" }));

    const app = await loadApp();
    const response = await app.request("/api/v1/skills/install", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "zip is too large" });
    const { access } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { SKILLS_INSTALL_DIR } = await import("@qingagent/core");
    await expect(access(join(SKILLS_INSTALL_DIR, skillName))).rejects.toThrow();
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

  it("并发直写同名技能时仅一个成功，最终文件完整且属于成功方", async () => {
    const skillName = "atomic-concurrent-skill";
    const { readFile } = await import("node:fs/promises");
    const { SKILLS_INSTALL_DIR } = await import("@qingagent/core");
    const { join } = await import("node:path");
    installDir = join(SKILLS_INSTALL_DIR, skillName);
    const candidates = [
      `---\nname: ${skillName}\ndescription: 候选甲\n---\n# 完整内容甲\n`,
      `---\nname: ${skillName}\ndescription: 候选乙\n---\n# 完整内容乙\n`,
    ];
    const app = await loadApp();

    const responses = await Promise.all(candidates.map((skillMd) =>
      app.request("/api/v1/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillMd }),
      }),
    ));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const successIndex = responses.findIndex((response) => response.status === 200);
    expect(await readFile(join(installDir, "SKILL.md"), "utf8")).toBe(
      candidates[successIndex],
    );
    await expect(responses.find((response) => response.status === 409)!.json())
      .resolves.toEqual({ error: "这个技能已存在" });
  });

  it("直写 staging 写入失败不占用目标名，同名可重新安装", async () => {
    const skillName = "atomic-write-failure";
    const skillMd = `---\nname: ${skillName}\ndescription: 可重装\n---\n# 完整内容\n`;
    const fs = await import("node:fs/promises");
    const { SKILLS_INSTALL_DIR } = await import("@qingagent/core");
    const { join } = await import("node:path");
    const { installSkillMarkdown } = await import("../routes/skills");
    installDir = join(SKILLS_INSTALL_DIR, skillName);

    await expect(installSkillMarkdown(installDir, skillMd, {
      mkdtemp: fs.mkdtemp,
      rename: fs.rename,
      rm: fs.rm,
      writeFile: vi.fn(async () => {
        throw new Error("injected write failure");
      }) as typeof fs.writeFile,
    })).rejects.toThrow("injected write failure");
    await expect(fs.access(installDir)).rejects.toThrow();
    expect((await fs.readdir(SKILLS_INSTALL_DIR)).filter((name) => name.startsWith(".install-")))
      .toEqual([]);

    const app = await loadApp();
    const response = await app.request("/api/v1/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillMd }),
    });
    expect(response.status).toBe(200);
    await expect(fs.readFile(join(installDir, "SKILL.md"), "utf8")).resolves.toBe(skillMd);
  });

  it("归档内置技能名仍是保留名,不能导入同名自装技能", async () => {
    const archivedName = "archived-test-skill";
    const { ARCHIVED_BUILTIN_SKILLS } = await import("@qingagent/core");
    ARCHIVED_BUILTIN_SKILLS.add(archivedName);
    try {
      const app = await loadApp();
      const res = await app.request("/api/v1/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillMd: `---\nname: ${archivedName}\ndescription: 演示\n---\n# demo`,
        }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "这个技能已存在" });
    } finally {
      ARCHIVED_BUILTIN_SKILLS.delete(archivedName);
    }
  });
});

describe("技能导入 UX 元数据", () => {
  const installedNames = new Set<string>();

  beforeEach(async () => {
    process.env.QINGAGENT_ALLOW_SKILL_MUTATION = "1";
    const { mkdir } = await import("node:fs/promises");
    const { SKILLS_INSTALL_DIR } = await import("@qingagent/core");
    await Promise.all([
      mkdir(SKILLS_INSTALL_DIR, { recursive: true }),
      mkdir(TEST_LEGACY_SKILLS_DIR, { recursive: true }),
    ]);
  });

  afterEach(async () => {
    delete process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
    const { rm } = await import("node:fs/promises");
    await rm(TEST_LEGACY_SKILLS_DIR, { recursive: true, force: true });
    if (installedNames.size > 0) {
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

  it("legacy 技能归为已安装，PATCH 会在条目实际路径修改显示名", async () => {
    const app = await loadApp();
    const skillName = "legacy-rename-label-demo";
    const skillDir = `${TEST_LEGACY_SKILLS_DIR}/${skillName}`;
    const fs = await import("node:fs/promises");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      `${skillDir}/SKILL.md`,
      `---\nname: ${skillName}\ndescription: 历史自有技能\nlabel: 旧显示名\n---\n# demo`,
      "utf8",
    );

    const list = await app.request("/api/v1/skills");
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      skills: Array<{ name: string; source: string }>;
    };
    expect(listed.skills.find((skill) => skill.name === skillName)?.source).toBe("installed");

    const rename = await app.request(`/api/v1/skills/${skillName}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "历史技能新名" }),
    });
    expect(rename.status).toBe(200);
    const saved = await fs.readFile(`${skillDir}/SKILL.md`, "utf8");
    expect(parseSkillFrontmatter(saved)?.label).toBe("历史技能新名");
  });

  it("legacy 技能 DELETE 会删除条目实际目录", async () => {
    const app = await loadApp();
    const skillName = "legacy-delete-demo";
    const skillDir = `${TEST_LEGACY_SKILLS_DIR}/${skillName}`;
    const fs = await import("node:fs/promises");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      `${skillDir}/SKILL.md`,
      `---\nname: ${skillName}\ndescription: 待删除的历史自有技能\n---\n# demo`,
      "utf8",
    );

    const response = await app.request(`/api/v1/skills/${skillName}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    await expect(fs.access(skillDir)).rejects.toThrow();
  });

  it("mutation 路径守卫拒绝伪装成 installed 的已知根外路径", async () => {
    const fs = await import("node:fs/promises");
    const outside = `/tmp/qingagent-skill-path-traversal-${process.pid}`;
    await fs.mkdir(outside, { recursive: true });
    try {
      const { resolveInstalledSkillMutationPath } = await import("../routes/skills");
      await expect(resolveInstalledSkillMutationPath({
        path: outside,
        source: "installed",
      })).rejects.toThrow("技能路径不合法");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("PATCH 路由拒绝 legacy 技能文件符号链接逃逸，且不改写根外目标", async () => {
    const app = await loadApp();
    const skillName = "legacy-file-symlink-escape";
    const skillDir = `${TEST_LEGACY_SKILLS_DIR}/${skillName}`;
    const linkPath = `${skillDir}/SKILL.md`;
    const outside = `/tmp/qingagent-skill-route-escape-${process.pid}`;
    const outsideSkillMd = `${outside}/SKILL.md`;
    const fs = await import("node:fs/promises");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(
      outsideSkillMd,
      `---\nname: ${skillName}\ndescription: 根外技能\n---\n# demo`,
      "utf8",
    );
    await fs.symlink(outsideSkillMd, linkPath, "file");
    try {
      const response = await app.request(`/api/v1/skills/${skillName}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "不应写出" }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "技能路径不合法" });
      expect(await fs.readFile(outsideSkillMd, "utf8")).not.toContain("不应写出");
    } finally {
      await fs.rm(skillDir, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
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

  it("ZIP 导入保留标准子技能，母技能进入顶层列表而子技能不平铺", async () => {
    const app = await loadApp();
    const parentName = "nested-package-demo";
    const childName = "nested-child-demo";
    const zip = new JSZip();
    zip.file(
      "SKILL.md",
      `---\nname: ${parentName}\ndescription: 带子技能的导入包\n---\n# 母技能`,
    );
    zip.file(
      `${childName}/SKILL.md`,
      `---\nname: ${childName}\ndescription: 导入包子技能\nlabel: 子技能\nsummary: 仅归属母技能\n---\n# 子技能`,
    );
    const archive = await zip.generateAsync({ type: "arraybuffer" });
    const form = new FormData();
    form.set("file", new File([archive], "nested-skill.zip", { type: "application/zip" }));

    const install = await app.request("/api/v1/skills/install", {
      method: "POST",
      body: form,
    });
    expect(install.status).toBe(200);
    expect(await install.json()).toMatchObject({ installed: true, name: parentName });
    installedNames.add(parentName);

    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { SKILLS_INSTALL_DIR } = await import("@qingagent/core");
    await expect(
      readFile(join(SKILLS_INSTALL_DIR, parentName, childName, "SKILL.md"), "utf8"),
    ).resolves.toContain(`name: ${childName}`);

    const list = await app.request("/api/v1/skills");
    expect(list.status).toBe(200);
    const body = await list.json() as {
      skills: Array<{
        name: string;
        children: Array<{
          name: string;
          label: string;
          summary: string;
          icon: string;
          source: string;
          enabled: boolean;
          children: unknown[];
        }>;
      }>;
    };
    const names = body.skills.map((skill) => skill.name);
    expect(names).toContain(parentName);
    expect(names).not.toContain(childName);
    expect(body.skills.find((skill) => skill.name === parentName)?.children).toEqual([
      expect.objectContaining({
        name: childName,
        label: "子技能",
        summary: "仅归属母技能",
        icon: "star",
        source: "installed",
        enabled: true,
        children: [],
      }),
    ]);
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
