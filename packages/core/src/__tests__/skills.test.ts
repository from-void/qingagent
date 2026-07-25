import { describe, expect, it } from "vitest";
import { LocalFilesystem, Workspace } from "@mastra/core/workspace";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { resolveEnabledSkillDirsFromRoots } from "../agents/qingagent.js";
import { BUILTIN_SKILLS_DIR, USER_SKILLS_DIR } from "../skills/paths.js";
import { ARCHIVED_BUILTIN_SKILLS } from "../skills/archived.js";
import {
  listChildSkills,
  listTopLevelSkills,
  scanSkillHierarchy,
} from "../skills/discovery.js";

function parseFrontmatter(source: string): Record<string, unknown> {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("Missing frontmatter");
  const data: Record<string, unknown> = {};
  const lines = match[1]!.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyMatch) continue;
    const key = keyMatch[1]!;
    let value = keyMatch[2] ?? "";
    if (value === ">-" || value === "|") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) {
        i += 1;
        parts.push(lines[i]!.trim());
      }
      value = parts.join(" ");
    }
    data[key] = value;
  }
  return data;
}

describe("builtin skills", () => {
  it("发现 cli-auth 内部技能且显式禁止用户调用", async () => {
    const skillPath = join(BUILTIN_SKILLS_DIR, "capability", "cli-auth", "SKILL.md");
    const source = await readFile(skillPath, "utf8");
    const frontmatter = parseFrontmatter(source);

    expect(frontmatter).toMatchObject({
      name: "cli-auth",
      label: "命令行授权",
      "user-invocable": "false",
    });
    expect(source).toContain("mastra_workspace_get_process_output(pid, tail)");
    expect(source).toContain("auth_url redirect_uri jump_url");
    expect(source).toContain("发出二维码卡后立刻收尾并结束本轮回复");
    for (const keyword of [
      "在决定接入方式前",
      "init/login 类命令的 `--help`",
      "摸清它提供的全部接入方式",
      "优先选择自动化程度最高",
      "扫码、device flow 或非交互方式",
      "`--noninteractive`",
      "由产品渲染二维码卡让用户扫码",
      "不要主动把用户推去第三方管理后台手动创建应用",
      "复制 AppID/App Secret 等凭证",
      "完全没有任何自动授权方式时",
      "明确说明为什么只能手动",
      "运行这类命令前先查看该 CLI 的 `--help`",
      "“不自动打开浏览器”之类的选项",
      "启动命令**必须带上**",
      "具体参数名以该 CLI 的帮助为准",
      "严禁 kill 进程、严禁重新起进程、严禁重新出码",
      "还没检测到完成，可能还没生效/还在等待",
      "拿不准是哪种语义时，默认只轮询",
      "一次约 60 秒的有界 wait 返回后继续下一次",
      "不要把球踢回用户",
      "持续轮询只服务于**本轮**用户明确要求的等待",
      "下一轮必须优先处理新的用户文本",
      "否则不得因历史里仍有 PID/等待卡而自动续跑旧轮询",
      "新消息抢占只中止 Agent 等待，不代表后台进程已终止",
      '"completedCardId":"<首次返回的 cardId>"',
      "completionMessage",
      "note 位于二维码下方",
      "必须写“上方二维码/上面的二维码”",
      "禁止写“下方二维码/下面的二维码”",
    ]) {
      expect(source).toContain(keyword);
    }
    expect(source.indexOf("在决定接入方式前"))
      .toBeLessThan(source.indexOf("## 标准流程"));
  });

  it("发现 diagram-viz 内置技能，并在显式停用后从 Workspace 目录移除", async () => {
    const categoryRoots = [
      join(BUILTIN_SKILLS_DIR, "capability"),
      join(BUILTIN_SKILLS_DIR, "native"),
      join(BUILTIN_SKILLS_DIR, "style"),
    ];
    const enabledDirs = await resolveEnabledSkillDirsFromRoots(categoryRoots, new Set());
    const diagramDir = enabledDirs.find((dir) => basename(dir) === "diagram-viz");
    expect(diagramDir).toBeTruthy();

    const skillPath = join(diagramDir!, "SKILL.md");
    const frontmatter = parseFrontmatter(await readFile(skillPath, "utf8"));
    expect(frontmatter).toMatchObject({
      name: "diagram-viz",
      label: "图表可视化",
      "user-invocable": "true",
      "write-inject": "true",
    });

    const workspace = new Workspace({
      filesystem: new LocalFilesystem({
        basePath: BUILTIN_SKILLS_DIR,
        allowedPaths: [USER_SKILLS_DIR],
      }),
      skills: enabledDirs,
    });
    const skillsApi = workspace.skills;
    if (!skillsApi) throw new Error("Workspace skills are not configured");
    expect(await skillsApi.has("diagram-viz")).toBe(true);

    const disabledDirs = await resolveEnabledSkillDirsFromRoots(
      categoryRoots,
      new Set(["diagram-viz"]),
    );
    expect(disabledDirs.some((dir) => basename(dir) === "diagram-viz")).toBe(false);
  });

  it("将八类审查合并为 review，并允许旧禁用记录自然失效", async () => {
    const categoryRoots = [
      join(BUILTIN_SKILLS_DIR, "capability"),
      join(BUILTIN_SKILLS_DIR, "native"),
      join(BUILTIN_SKILLS_DIR, "style"),
    ];
    const oldReviewNames = [
      "sensitive-review",
      "source-check",
      "deai-review",
      "consistency-review",
      "privacy-review",
      "format-review",
      "role-review",
      "custom-review",
    ];
    const enabledDirs = await resolveEnabledSkillDirsFromRoots(
      categoryRoots,
      new Set(oldReviewNames),
    );
    const names = enabledDirs.map((dir) => basename(dir));

    expect(names).toContain("review");
    for (const oldName of oldReviewNames) {
      expect(names).not.toContain(oldName);
    }

    const reviewDir = enabledDirs.find((dir) => basename(dir) === "review");
    expect(reviewDir).toBeTruthy();
    const skill = await readFile(join(reviewDir!, "SKILL.md"), "utf8");
    const frontmatter = parseFrontmatter(skill);
    expect(frontmatter).toMatchObject({
      name: "review",
      label: "文档审查",
      summary: "统一执行八类文档审查",
      "user-invocable": "true",
    });
    expect(frontmatter["write-inject"]).toBeUndefined();
    for (const commonRule of [
      "纯批注模式，不改稿",
      "`writeDraft` 产出候选后",
      "`summary` 只写不超过 15 字",
      "只有模板明确要求严重度时才传",
      "同一固定 `origin` 或同名角色/自定义模板重跑时换代旧结果",
      "每次不超过 3 组",
    ]) {
      expect(skill).toContain(commonRule);
    }

    const childRules: Record<string, string[]> = {
      sensitive: ["`sensitive_scan`", '`reviewAction:"replace"`', '`reviewAction:"annotate"`'],
      "source-check": ["素材是唯一 ground truth", "`materialQuote`", "`checkedScope`", "素材遗漏"],
      deai: ["优先 `replaceText`", "痕迹类别：N 处", "保持段落结构、句序与篇幅"],
      consistency: ["`run_python` 或 `run_js`", "`documentQuote`", "称谓与术语"],
      privacy: ["模式类、语义类与间接组合泄露", "138****1234", "同一敏感值多次出现合为一组"],
      format: ["真实 heading level", "列表、表格与分栏", "不同统一目标不要塞进同一组"],
      role: ["角色身份、立场和审查维度", "不擅加模板没有要求的维度", "不调用 AI 或额外检索"],
      custom: ["模板 prompt 是本轮审查逻辑的完整来源", "不额外发明固定维度", "不伪造引句"],
    };
    for (const [childName, rules] of Object.entries(childRules)) {
      expect(skill).toContain(`${childName}/SKILL.md`);
      const childSkill = await readFile(
        join(reviewDir!, childName, "SKILL.md"),
        "utf8",
      );
      const childFrontmatter = parseFrontmatter(childSkill);
      expect(childFrontmatter).toMatchObject({
        name: childName,
        description: expect.any(String),
        label: expect.any(String),
        summary: expect.any(String),
      });
      expect(childSkill).toMatch(/\n# (?:.+审查|来源核查|去 AI 味)/);
      for (const rule of rules) expect(childSkill).toContain(rule);
    }
  });

  it("review、diagram-viz 与 image-gen 暴露标准子技能列表，Mastra 顶层列表不平铺子技能", async () => {
    const capabilityRoot = join(BUILTIN_SKILLS_DIR, "capability");
    const reviewDir = join(capabilityRoot, "review");
    const diagramDir = join(capabilityRoot, "diagram-viz");
    const imageGenDir = join(capabilityRoot, "image-gen");
    const reviewChildren = await listChildSkills(reviewDir);
    const diagramChildren = await listChildSkills(diagramDir);
    const imageGenChildren = await listChildSkills(imageGenDir);

    expect(reviewChildren.map((skill) => skill.metadata.name).sort()).toEqual([
      "consistency",
      "custom",
      "deai",
      "format",
      "privacy",
      "role",
      "sensitive",
      "source-check",
    ]);
    expect(diagramChildren.map((skill) => skill.metadata.name).sort()).toEqual([
      "drawio",
      "mermaid",
    ]);
    expect(imageGenChildren.map((skill) => skill.metadata.name).sort()).toEqual([
      "codex-image",
      "svg",
    ]);

    const enabledDirs = await resolveEnabledSkillDirsFromRoots([capabilityRoot], new Set());
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({ basePath: BUILTIN_SKILLS_DIR }),
      skills: enabledDirs,
    });
    const listedNames = (await workspace.skills?.list() ?? []).map((skill) => skill.name);
    expect(listedNames).toContain("review");
    expect(listedNames).toContain("diagram-viz");
    expect(listedNames).toContain("image-gen");
    for (const childName of [
      ...reviewChildren.map((skill) => skill.metadata.name),
      ...diagramChildren.map((skill) => skill.metadata.name),
      ...imageGenChildren.map((skill) => skill.metadata.name),
    ]) {
      expect(listedNames).not.toContain(childName);
    }
  });

  it("嵌套扫描按最近合法祖先归属，纯资料目录与非法 frontmatter 不成为技能", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-skill-hierarchy-"));
    try {
      const writeSkill = async (
        relativeDir: string,
        name: string,
        description = `测试技能 ${name}`,
      ): Promise<void> => {
        const dir = join(root, relativeDir);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
          "utf8",
        );
      };
      await writeSkill("parent", "parent");
      await writeSkill("parent/direct", "direct");
      await writeSkill("parent/direct/grandchild", "grandchild");
      await writeSkill("parent/references/grouped", "grouped");
      await writeSkill("peer", "peer");
      await mkdir(join(root, "parent", "references", "notes"), { recursive: true });
      await writeFile(
        join(root, "parent", "references", "notes", "guide.md"),
        "纯资料，不是技能。",
        "utf8",
      );
      await mkdir(join(root, "parent", "broken"), { recursive: true });
      await writeFile(
        join(root, "parent", "broken", "SKILL.md"),
        "---\nname: INVALID_NAME\ndescription: 非法技能\n---\n",
        "utf8",
      );

      const hierarchy = await scanSkillHierarchy(root);
      const byName = new Map(hierarchy.map((skill) => [skill.metadata.name, skill]));
      expect((await listTopLevelSkills(root)).map((skill) => skill.metadata.name).sort()).toEqual([
        "parent",
        "peer",
      ]);
      expect((await listChildSkills(join(root, "parent"))).map((skill) => skill.metadata.name).sort())
        .toEqual(["direct", "grouped"]);
      expect(byName.get("direct")?.parentPath).toBe(byName.get("parent")?.path);
      expect(byName.get("grouped")?.parentPath).toBe(byName.get("parent")?.path);
      expect(byName.get("grandchild")?.parentPath).toBe(byName.get("direct")?.path);
      expect(hierarchy.some((skill) => skill.path.endsWith("/references/notes"))).toBe(false);
      expect(hierarchy.some((skill) => skill.path.endsWith("/broken"))).toBe(false);

      // USER_SKILLS_DIR 与内置技能根共用同一扫描入口：解析给 Workspace 的仍只有母技能。
      const workspaceDirs = await resolveEnabledSkillDirsFromRoots([root], new Set());
      expect(workspaceDirs.map((dir) => basename(dir)).sort()).toEqual(["parent", "peer"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads browser-ops from the capability category with valid frontmatter", async () => {
    const workspace = new Workspace({
      filesystem: new LocalFilesystem({
        basePath: BUILTIN_SKILLS_DIR,
        allowedPaths: [USER_SKILLS_DIR],
      }),
      skills: ["capability"],
    });

    const skillsApi = workspace.skills;
    if (!skillsApi) throw new Error("Workspace skills are not configured");
    const skills = await skillsApi.list();
    const browserOps = skills.find((skill) => skill.name === "browser-ops");
    expect(browserOps).toBeTruthy();
    expect(browserOps?.description).toEqual(expect.any(String));
    expect(browserOps?.description.length).toBeGreaterThan(0);

    const skillPath = resolve(BUILTIN_SKILLS_DIR, "capability", "browser-ops", "SKILL.md");
    const frontmatter = parseFrontmatter(await readFile(skillPath, "utf8"));
    expect(frontmatter.name).toBe(basename(dirname(skillPath)));
    expect(frontmatter.description).toEqual(expect.any(String));
    expect((frontmatter.description as string).length).toBeGreaterThan(0);
  });

  it("归档清单为空时仍正常发现内置技能", async () => {
    const skillDirs = await resolveEnabledSkillDirsFromRoots(
      [
        join(BUILTIN_SKILLS_DIR, "capability"),
        join(BUILTIN_SKILLS_DIR, "native"),
        join(BUILTIN_SKILLS_DIR, "style"),
      ],
      new Set(),
    );

    expect(ARCHIVED_BUILTIN_SKILLS.size).toBe(0);
    expect(skillDirs.some((dir) => basename(dir) === "browser-ops")).toBe(true);

    const workspace = new Workspace({
      filesystem: new LocalFilesystem({
        basePath: BUILTIN_SKILLS_DIR,
        allowedPaths: [USER_SKILLS_DIR],
      }),
      skills: skillDirs,
    });
    const skillsApi = workspace.skills;
    if (!skillsApi) throw new Error("Workspace skills are not configured");

    expect(await skillsApi.has("browser-ops")).toBe(true);
  });

  it("keeps skills from healthy roots when another root cannot be scanned", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-skills-"));
    try {
      const healthyRoot = join(root, "healthy");
      const skillDir = join(healthyRoot, "healthy-skill");
      const brokenRoot = join(root, "broken-root-is-file");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: healthy-skill\ndescription: 测试技能\n---\n",
        "utf8",
      );
      await writeFile(brokenRoot, "not a directory", "utf8");

      const skillDirs = await resolveEnabledSkillDirsFromRoots([brokenRoot, healthyRoot], new Set());

      expect(skillDirs.map((dir) => basename(dir))).toEqual(["healthy-skill"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 密闭回归(单②):此前本套件曾"单跑绿、全量红"——旧版第二个用例调 arg-less
  // resolveEnabledSkillDirs(),它读本机 ~/.qingagent/skills 的 .disabled.json;当本机或
  // 兄弟测试留下禁用 browser-ops 的 .disabled.json 时,browser-ops 被过滤 → 断言红。
  // 修法(e2e98c2)是改喂显式 roots + 空 disabled 集。本用例把该隔离性钉死成回归:
  // resolveEnabledSkillDirsFromRoots 必须是 (roots, disabled) 的纯函数——只看传入的 tmp
  // roots 与显式 disabled 集,绝不回读真实 BUILTIN_SKILLS_DIR 或全局 .disabled.json。
  it("resolveEnabledSkillDirsFromRoots 只认传入的 tmp roots 与显式禁用集(隔离全局 .disabled.json 污染)", async () => {
    const root = await mkdtemp(join(tmpdir(), "qingagent-skills-hermetic-"));
    const archivedName = "archived-test-skill";
    ARCHIVED_BUILTIN_SKILLS.add(archivedName);
    try {
      const category = join(root, "capability");
      const makeSkill = async (name: string): Promise<void> => {
        const dir = join(category, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: 测试技能 ${name}\n---\n`, "utf8");
      };
      await makeSkill("browser-ops"); // 未归档、未禁用 → 应存活
      await makeSkill(archivedName); // 归档名(location 无关)→ 应被过滤
      await makeSkill("team-notes"); // 正常技能,但被显式塞进禁用集 → 应被过滤

      const dirs = await resolveEnabledSkillDirsFromRoots([category], new Set(["team-notes"]));
      const names = dirs.map((dir) => basename(dir));

      expect(names).toContain("browser-ops");
      expect(names).not.toContain(archivedName);
      expect(names).not.toContain("team-notes");
    } finally {
      ARCHIVED_BUILTIN_SKILLS.delete(archivedName);
      await rm(root, { recursive: true, force: true });
    }
  });
});
