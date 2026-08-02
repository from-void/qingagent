import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalUserSkillsDir = process.env.QINGAGENT_USER_SKILLS_DIR;
const tempDirs: string[] = [];

vi.mock("../tools/runPython.js", () => ({
  getPyodideTools: () => ({}),
}));

async function withStore() {
  const dir = await mkdtemp(join(tmpdir(), "qingagent-skills-"));
  tempDirs.push(dir);
  vi.resetModules();
  process.env.QINGAGENT_USER_SKILLS_DIR = join(dir, "skills");
  return import("../skills/enabledStore.js");
}

async function withStoreFile(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), "qingagent-skills-"));
  tempDirs.push(dir);
  const skillsDir = join(dir, "skills");
  await mkdir(skillsDir, { recursive: true });
  await writeFile(join(skillsDir, ".disabled.json"), contents, "utf8");
  vi.resetModules();
  process.env.QINGAGENT_USER_SKILLS_DIR = skillsDir;
  return import("../skills/enabledStore.js");
}

afterEach(async () => {
  process.env.QINGAGENT_USER_SKILLS_DIR = originalUserSkillsDir;
  vi.doUnmock("@qingagent/doc-render/browser");
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("enabledStore", () => {
  it("round-trips disabled skill names", async () => {
    const store = await withStore();

    expect(await store.readDisabledSet()).toEqual(new Set());

    await store.setEnabled("web-search", false);
    expect(await store.isDisabled("web-search")).toBe(true);
    expect(await store.readDisabledSet()).toEqual(new Set(["web-search"]));

    await store.setEnabled("web-search", true);
    expect(await store.readDisabledSet()).toEqual(new Set());
  });

  it("清单损坏时沿用本进程最近一次有效禁用集合", async () => {
    const store = await withStore();
    await store.setEnabled("web-search", false);
    const disabledFile = join(process.env.QINGAGENT_USER_SKILLS_DIR!, ".disabled.json");
    await writeFile(disabledFile, "{ invalid json", "utf8");

    expect(await store.readDisabledSet()).toEqual(new Set(["web-search"]));
  });

  it("冷启动遇到损坏清单时 fail-closed 视为全部技能禁用", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = await withStoreFile("{ invalid json");

    const disabled = await store.readDisabledSet();

    expect(disabled.has("web-search")).toBe(true);
    expect(disabled.has("future-optional-skill")).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("omits disabled capability tools", async () => {
    const store = await withStore();
    await store.setEnabled("web-search", false);

    const { buildCapabilityTools } = await import("../session/sessionTools.js");
    const tools = await buildCapabilityTools();

    expect(tools).not.toHaveProperty("webSearch");
    expect(tools).not.toHaveProperty("fetchArticle");
    expect(tools).toHaveProperty("generateSvg");
    expect(tools).toHaveProperty("prepareImageEditSource");
    expect(tools).toHaveProperty("editSvgWithCodexFallback");
    expect(tools).toHaveProperty("importGeneratedImage");
    expect(tools).toHaveProperty("run_js");
  });

  it("keeps run_js available when doc-calc is disabled", async () => {
    const store = await withStore();
    await store.setEnabled("doc-calc", false);

    const { buildCapabilityTools } = await import("../session/sessionTools.js");
    const tools = await buildCapabilityTools();

    expect(tools).toHaveProperty("run_js");
  });

  it("omits all image generation and editing tools when image-gen is disabled", async () => {
    const store = await withStore();
    await store.setEnabled("image-gen", false);

    const { buildCapabilityTools } = await import("../session/sessionTools.js");
    const tools = await buildCapabilityTools();

    expect(tools).not.toHaveProperty("generateSvg");
    expect(tools).not.toHaveProperty("prepareImageEditSource");
    expect(tools).not.toHaveProperty("editSvgWithCodexFallback");
    expect(tools).not.toHaveProperty("importGeneratedImage");
  });

  it("omits browser tools when browser-ops is disabled", async () => {
    const store = await withStore();
    await store.setEnabled("browser-ops", false);
    vi.doMock("@qingagent/doc-render/browser", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@qingagent/doc-render/browser")>()),
      getAgentBrowserTools: () => ({
        browser_goto: { id: "browser_goto" },
        browser_click: { id: "browser_click" },
      }),
    }));

    const { buildCapabilityTools } = await import("../session/sessionTools.js");
    const tools = await buildCapabilityTools();

    expect(Object.keys(tools).filter((name) => name.startsWith("browser_"))).toEqual([]);
  });
});
