import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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

afterEach(async () => {
  process.env.QINGAGENT_USER_SKILLS_DIR = originalUserSkillsDir;
  vi.doUnmock("../browser/agentBrowser.js");
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

  it("omits disabled capability tools", async () => {
    const store = await withStore();
    await store.setEnabled("web-search", false);

    const { buildCapabilityTools } = await import("../bridge/sessionTools.js");
    const tools = await buildCapabilityTools();

    expect(tools).not.toHaveProperty("webSearch");
    expect(tools).toHaveProperty("scrapeWithBrowser");
    expect(tools).toHaveProperty("generateSvg");
    expect(tools).toHaveProperty("run_js");
  });

  it("keeps run_js available when doc-calc is disabled", async () => {
    const store = await withStore();
    await store.setEnabled("doc-calc", false);

    const { buildCapabilityTools } = await import("../bridge/sessionTools.js");
    const tools = await buildCapabilityTools();

    expect(tools).toHaveProperty("run_js");
  });

  it("omits scrapeWithBrowser and browser tools when browser-ops is disabled", async () => {
    const store = await withStore();
    await store.setEnabled("browser-ops", false);
    vi.doMock("../browser/agentBrowser.js", () => ({
      getAgentBrowserTools: () => ({
        browser_goto: { id: "browser_goto" },
        browser_click: { id: "browser_click" },
      }),
    }));

    const { buildCapabilityTools } = await import("../bridge/sessionTools.js");
    const tools = await buildCapabilityTools();

    expect(tools).not.toHaveProperty("scrapeWithBrowser");
    expect(Object.keys(tools).filter((name) => name.startsWith("browser_"))).toEqual([]);
  });
});
