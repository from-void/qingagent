// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenerateSvgCardBody, ResearchCardBody, ToolCallSpec } from "@qingagent/contract-ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import gallerySource from "../../../gallery/GalleryPage.tsx?raw";
import revampUiSource from "../../../gallery/revampUi.tsx?raw";
import cssText from "../../components/chatUnified.css?raw";
import {
  TOOL_LABELS,
  UResearch,
  USvg,
  UToolBar,
  type MaterialLabelMap,
  type SkillLabelMap,
} from "../../components/chatUnified";

// 注意:vite 会把 .css 当副作用模块处理,`?raw` 在 vitest 里返回空串,
// 因此需要真实 CSS 文本做守门断言时,必须直接从磁盘读源文件(测试固定从 apps/web 运行)。
const chatCss = readFileSync(
  resolve(process.cwd(), "src/pages/workspace/components/chatUnified.css"),
  "utf8",
);

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  host.id = "view-workspace";
  // 统一组件 token 挂在 .u-scope(生产中即 .ws-chat);测试里直接给宿主加。
  host.classList.add("u-scope");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function renderResearch(body: ResearchCardBody) {
  act(() => root.render(<UResearch body={body} />));
}
function renderBar(spec: ToolCallSpec, skillLabels?: SkillLabelMap, materialLabels?: MaterialLabelMap) {
  act(() => root.render(
    <UToolBar spec={spec} skillLabels={skillLabels} materialLabels={materialLabels} />,
  ));
}
function renderSvg(body: GenerateSvgCardBody, status: string) {
  act(() => root.render(<USvg body={body} status={status} />));
}

describe("UResearch", () => {
  it("searching 阶段不可折叠、不渲染列表行", () => {
    renderResearch({
      query: "宋代点茶的器具与流程",
      phase: "searching", items: [], total: null, fetchedCount: 0, okCount: 0, skippedCount: 0,
    });
    expect(host.textContent).toContain("检索中…");
    // searching 不可折叠 → 头部是 div 而非按钮
    expect(host.querySelector("button.u-card-hd")).toBeNull();
    expect(host.querySelector(".u-list-row")).toBeNull();
  });

  it("fetching 阶段逐行状态:done 字数 / fetching 抓取中 / browser 经浏览器 / pending 待抓取(不转圈)", () => {
    renderResearch({
      query: "宋代点茶的器具与流程",
      phase: "fetching", total: 4, fetchedCount: 1, okCount: 1, skippedCount: 0,
      items: [
        { title: "宋代点茶法考", url: "https://example.com/done", status: "done", wordCount: 1204 },
        { title: "茶筅与茶盏", url: "https://example.com/fetching", status: "fetching", wordCount: null },
        { title: "建盏与点茶", url: "https://example.com/browser", status: "browser", wordCount: null },
        { title: "饮茶方式演变", url: "https://example.com/pending", status: "pending", wordCount: null },
      ],
    });
    expect(host.querySelectorAll(".u-list-row")).toHaveLength(4);
    expect(host.textContent).toContain("抓取 1/4");
    expect(host.textContent).toContain("1,204 字");
    expect(host.textContent).toContain("抓取中");
    expect(host.textContent).toContain("经浏览器");
    expect(host.textContent).toContain("待抓取");
    // pending 用静态灰点(.u-list-wait),不是转圈(.u-spin)
    expect(host.querySelector(".u-list-wait")).not.toBeNull();
    // fetching + browser 两行转圈;pending/done 不转 → 恰好 2 个 spin
    expect(host.querySelectorAll(".u-list .u-spin")).toHaveLength(2);
  });

  it("done 阶段默认折叠为「N 篇」,展开后 skipped 不展示", () => {
    renderResearch({
      query: "宋代点茶的器具与流程",
      phase: "done", total: 3, fetchedCount: 3, okCount: 2, skippedCount: 1,
      items: [
        { title: "宋代点茶法考", url: "https://example.com/done-a", status: "done", wordCount: 1204 },
        { title: "点茶美学", url: "https://example.com/done-b", status: "done", wordCount: 890 },
        { title: "空壳页面", url: "https://example.com/skipped", status: "skipped", wordCount: null },
      ],
    });
    expect(host.textContent).toContain("2 篇");
    expect(host.querySelector(".u-list-row")).toBeNull();
    const header = host.querySelector<HTMLButtonElement>("button.u-card-hd");
    expect(header).not.toBeNull();
    expect(header!.getAttribute("aria-expanded")).toBe("false");
    act(() => header!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(header!.getAttribute("aria-expanded")).toBe("true");
    // skipped 已过滤,只剩 2 行成功项
    expect(host.querySelectorAll(".u-list-row")).toHaveLength(2);
  });

  // F1 回归(用户走查):长 URL(如百科 percent-encoded 链接)不得向右捅破卡片。
  // 结构:左列(标题+链接)可伸缩截断,右列状态标签独立不换行。
  it("超长 URL 走左右布局:链接可截断、状态标签独立,不撑破容器", () => {
    const longUrl =
      "https://baike.baidu.com/item/" +
      encodeURIComponent("宋代点茶的器具与流程及其历史演变考据") +
      "/12345678?fromModule=lemma_search-box&" +
      "a=" + "b".repeat(200);
    renderResearch({
      query: "宋代点茶", phase: "fetching", total: 1, fetchedCount: 1, okCount: 1, skippedCount: 0,
      items: [{ title: "宋代点茶法考", url: longUrl, status: "done", wordCount: 2005 }],
    });
    const row = host.querySelector<HTMLElement>(".u-list-row");
    const main = row?.querySelector<HTMLElement>(".u-list-main");
    const url = main?.querySelector<HTMLAnchorElement>("a.u-list-url");
    const tag = row?.querySelector<HTMLElement>(".u-list-tag");
    // 链接在左列可伸缩容器内、状态标签是行内独立兄弟节点。
    expect(main).not.toBeNull();
    expect(url).not.toBeNull();
    expect(url?.getAttribute("href")).toBe(longUrl);
    expect(tag?.textContent).toBe("2,005 字");
    // 标签不在左列里(避免被链接挤走)。
    expect(main?.contains(tag ?? null)).toBe(false);

    // CSS 守门:左列 min-width:0、链接置块级 + 截断三件套、右列 nowrap。
    const urlRule = /\.u-list-url\s*\{([^}]*)\}/.exec(chatCss)?.[1] ?? "";
    expect(urlRule).toMatch(/display:\s*block/);
    expect(urlRule).toMatch(/overflow:\s*hidden/);
    expect(urlRule).toMatch(/text-overflow:\s*ellipsis/);
    expect(urlRule).toMatch(/white-space:\s*nowrap/);
    const mainRule = /\.u-list-main\s*\{([^}]*)\}/.exec(chatCss)?.[1] ?? "";
    expect(mainRule).toMatch(/min-width:\s*0/);
    const tagRule = /\.u-list-tag\s*\{([^}]*)\}/.exec(chatCss)?.[1] ?? "";
    expect(tagRule).toMatch(/white-space:\s*nowrap/);
  });
});

describe("UToolBar", () => {
  function genericSpec(status: ToolCallSpec["status"]["kind"], argsJson: string, name = "webSearch"): ToolCallSpec {
    return {
      id: "t1", name,
      status: { kind: status } as ToolCallSpec["status"],
      body: { kind: "generic", data: { argsJson } },
      result: null,
    } as ToolCallSpec;
  }

  it("状态文案:pending 等待中(黄点) / running 处理中 / done 已完成(对勾)", () => {
    renderBar(genericSpec("pending", "{}"));
    expect(host.textContent).toContain("等待中");
    expect(host.querySelector(".u-dot")).not.toBeNull();

    renderBar(genericSpec("running", "{}"));
    expect(host.textContent).toContain("处理中");

    renderBar(genericSpec("done", "{}"));
    expect(host.textContent).toContain("已完成");
  });

  it("#27 writeDraft 参数生成期占位显示「酝酿中…」", () => {
    renderBar(genericSpec("running", "", "writeDraft"));

    expect(host.querySelector('[data-wf="ToolPrep"]')).not.toBeNull();
    expect(host.textContent).toContain("酝酿中…");
    expect(host.textContent).not.toContain("正在准备生成草稿");
  });

  it("Mastra workspace 真实注入工具 id 都有中文标签,含 grep/search", () => {
    const expected: Record<string, string> = {
      mastra_workspace_read_file: "读取文件",
      mastra_workspace_write_file: "写入文件",
      mastra_workspace_edit_file: "编辑文件",
      mastra_workspace_list_files: "列出文件",
      mastra_workspace_grep: "搜索文件",
      mastra_workspace_search: "搜索工作区",
      mastra_workspace_search_output: "搜索文件",
      mastra_workspace_execute_command: "运行命令",
      mastra_workspace_get_process_output: "读取运行输出",
      mastra_workspace_kill_process: "结束进程",
    };
    for (const [id, label] of Object.entries(expected)) {
      expect(TOOL_LABELS[id], id).toBe(label);
    }

    renderBar(genericSpec("done", "{\"pattern\":\"TODO\"}", "mastra_workspace_grep"));
    expect(host.textContent).toContain("搜索文件");
    renderBar(genericSpec("done", "{\"query\":\"TODO\"}", "mastra_workspace_search"));
    expect(host.textContent).toContain("搜索工作区");
  });

  it("skill_read 可从 id 取主参并用 API label 显示中文名", () => {
    renderBar(genericSpec("done", "{\"id\":\"lark-doc\"}", "skill_read"), {
      "lark-doc": "飞书文档",
    });
    expect(host.textContent).toContain("读取技能");
    expect(host.textContent).toContain("飞书文档");
    expect(host.textContent).not.toContain("lark-doc");
  });

  it("skill_read 找不到 API label 时回退技能 id", () => {
    renderBar(genericSpec("done", "{\"id\":\"unknown-skill\"}", "skill_read"));
    expect(host.textContent).toContain("读取技能");
    expect(host.textContent).toContain("unknown-skill");
  });

  it("readMaterial 用完整 materialId 查表显示素材名", () => {
    const materialId = "76a681d9-54aa-4dee-9123-ccfc32ba35c";
    renderBar(
      genericSpec("done", JSON.stringify({ materialId }), "readMaterial"),
      undefined,
      { [materialId]: "赛事手册.pdf" },
    );

    expect(host.textContent).toContain("读取素材");
    expect(host.textContent).toContain("赛事手册.pdf");
    expect(host.textContent).not.toContain("76a681d9-54");
  });

  it("readMaterial 找不到素材名时回退截断后的 materialId", () => {
    const materialId = "76a681d9-54aa-4dee-9123-ccfc32ba35c";
    renderBar(genericSpec("done", JSON.stringify({ materialId }), "readMaterial"));

    expect(host.textContent).toContain("76a681d9-54…ccfc32ba35c");
  });

  it("argsJson 为合法但非对象(null / 数组)时不崩,降级无主参", () => {
    expect(() => renderBar(genericSpec("running", "null"))).not.toThrow();
    expect(host.textContent).toContain("联网搜索");
    expect(() => renderBar(genericSpec("running", "[1,2,3]"))).not.toThrow();
    expect(() => renderBar(genericSpec("running", "not json"))).not.toThrow();
  });

  // 完成态状态文案:result 为 genericText、data 是后端 toolResultCardSummary 的紧凑 JSON
  // (顶层标量 / 数组长度 `<key>Count` / 下钻一层 `<父>.<子>` 标量)。
  function doneSpec(name: string, resultData: Record<string, unknown>): ToolCallSpec {
    return {
      id: "d1", name,
      status: { kind: "done" } as ToolCallSpec["status"],
      body: { kind: "generic", data: { argsJson: "{}" } },
      result: { kind: "genericText", data: JSON.stringify(resultData) },
    } as ToolCallSpec;
  }

  it("editDraft 完成态显示「改 N 处」(hunkCount 优先)", () => {
    renderBar(doneSpec("editDraft", { ok: true, appliedCount: 5, changed: true, hunkCount: 3 }));
    expect(host.textContent).toContain("改 3 处");
    expect(host.textContent).not.toContain("已完成");
  });

  it("editDraft 无 hunkCount 时回退到 appliedCount;changed=false 时「未改动」", () => {
    renderBar(doneSpec("editDraft", { ok: true, appliedCount: 2, changed: true }));
    expect(host.textContent).toContain("改 2 处");
    renderBar(doneSpec("editDraft", { ok: true, appliedCount: 0, changed: false }));
    expect(host.textContent).toContain("未改动");
  });

  it("readDiff 完成态显示「N 处差异」(stats.blocksChanged+marksChanged),0 时「无差异」", () => {
    renderBar(doneSpec("readDiff", {
      ok: true, changesCount: 4,
      "stats.blocksChanged": 3, "stats.marksChanged": 1, "stats.totalWords": 820,
    }));
    expect(host.textContent).toContain("4 处差异");
    renderBar(doneSpec("readDiff", {
      ok: true, changesCount: 0,
      "stats.blocksChanged": 0, "stats.marksChanged": 0, "stats.totalWords": 820,
    }));
    expect(host.textContent).toContain("无差异");
  });

  it("readDiff 退化:无 stats 时用 changesCount", () => {
    renderBar(doneSpec("readDiff", { ok: true, changesCount: 2 }));
    expect(host.textContent).toContain("2 处差异");
  });

  it("parseFile 从嵌套 metadata.wordCount 提炼字数", () => {
    renderBar(doneSpec("parseFile", { "metadata.wordCount": 1530, "metadata.pages": 4 }));
    expect(host.textContent).toContain("1.5K 字");
  });

  it("readMaterial / fetchArticle 显示字数", () => {
    renderBar(doneSpec("readMaterial", { filename: "a.md", wordCount: 642 }));
    expect(host.textContent).toContain("642 字");
    renderBar(doneSpec("fetchArticle", { wordCount: 2048, imagesCount: 3, via: "static" }));
    expect(host.textContent).toContain("2K 字");
  });

  it("webSearch 显示「N 条」(itemsCount)", () => {
    renderBar(doneSpec("webSearch", { ok: true, query: "宋代点茶", itemsCount: 5 }));
    expect(host.textContent).toContain("5 条");
  });

  it("storeMaterial / summarizeMaterial / readImage / run_js 布尔态文案", () => {
    renderBar(doneSpec("storeMaterial", { materialId: "m1", stored: true }));
    expect(host.textContent).toContain("已存素材");
    renderBar(doneSpec("summarizeMaterial", { updated: true }));
    expect(host.textContent).toContain("已更新");
    renderBar(doneSpec("readImage", { ok: true }));
    expect(host.textContent).toContain("已识别");
    renderBar(doneSpec("run_js", { ok: false }));
    expect(host.textContent).toContain("运行失败");
  });

  it("readImage ok=false 渲染成需配置/失败态,不误显已完成;且不再红色报错(设计原则)", () => {
    renderBar(doneSpec("readImage", {
      ok: false,
      text: "",
      error: "还未配置图像识别模型,请在 设置 → 技能 → 图像识别 里填写模型 API Key。",
    }));

    expect(host.textContent).toContain("需配置视觉模型");
    expect(host.textContent).not.toContain("已完成");
    // 设计原则:工具"只要调过了"就不再红色报错——失败/需配置态一律常规图标,不加 is-error。
    expect(host.querySelector(".u-ico.is-error")).toBeNull();
    expect(host.querySelector(".u-meta.is-error")).toBeNull();
    // 但排查提示仍保留在 .u-meta 的 title 上,指引用户去配置。
    const meta = host.querySelector<HTMLElement>(".u-meta");
    expect(meta?.getAttribute("title")).toContain("设置 → 技能 → 图像识别");
  });

  it("readDraft 优先字数,退化为「N 块」", () => {
    renderBar(doneSpec("readDraft", { ok: true, blockCount: 12, wordCount: 480 }));
    expect(host.textContent).toContain("480 字");
    renderBar(doneSpec("readDraft", { ok: true, blockCount: 12 }));
    expect(host.textContent).toContain("12 块");
  });

  it("未识别工具 + 无可提炼字段 → 回退「已完成」", () => {
    renderBar(doneSpec("someUnknownTool", { ok: true }));
    expect(host.textContent).toContain("已完成");
  });

  it("askUser overlay 兜底成「确认方向」而非裸「工具调用」", () => {
    const spec = {
      id: "a1", name: "askUser",
      status: { kind: "running" },
      body: { kind: "askUser", data: { mode: { kind: "overlay" }, questions: [], source: null } },
      result: null,
    } as unknown as ToolCallSpec;
    renderBar(spec);
    expect(host.textContent).toContain("确认方向");
    expect(host.textContent).not.toContain("工具调用");
  });

  it("共用 askUser body 时仍按工具名区分 planDraft 与 askUserQuestion 标题", () => {
    const questionnaire = (name: "planDraft" | "askUserQuestion") => ({
      id: name,
      name,
      status: { kind: "running" },
      body: { kind: "askUser", data: { mode: { kind: "overlay" }, questions: [], source: null } },
      result: null,
    }) as unknown as ToolCallSpec;

    renderBar(questionnaire("planDraft"));
    expect(host.textContent).toContain("确认方向");
    renderBar(questionnaire("askUserQuestion"));
    expect(host.textContent).toContain("有问题待确认");
    expect(host.textContent).not.toContain("确认方向");
  });
});

describe("USvg", () => {
  function svgBody(stage: "streaming" | "done", src: string | null): GenerateSvgCardBody {
    return {
      prompt: "画一张示意图",
      style: "line",
      aspect: "16:9",
      progress: {
        stage,
        elapsedMs: 100,
        rawKb: 1,
        message: "",
        error: null,
        src,
        width: 160,
        height: 90,
        partialSvg: stage === "streaming" ? "<svg viewBox=\"0 0 1 1\"></svg>" : null,
      },
    };
  }

  it("running→done 边沿自动折叠一次,用户展开后 rerender 不会再次折回", () => {
    renderSvg(svgBody("streaming", null), "running");
    const header = () => host.querySelector<HTMLButtonElement>("button.u-card-hd");
    expect(header()?.getAttribute("aria-expanded")).toBe("true");

    renderSvg(svgBody("done", "data:image/svg+xml,<svg/>"), "done");
    expect(header()?.getAttribute("aria-expanded")).toBe("false");

    act(() => header()?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(header()?.getAttribute("aria-expanded")).toBe("true");

    renderSvg(svgBody("done", "data:image/svg+xml,<svg/>"), "done");
    expect(header()?.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("对话改造画廊源码约束", () => {
  it("不再携带旧骨架函数、旧工具映射名和废弃 patch demo", () => {
    const staleHelperNames = [
      "U" + "Card",
      "U" + "MiniBar",
      "U" + "Thinking",
      "U" + "Loading",
      "U" + "Empty",
      "U" + "Error",
      "U" + "UserBubble",
    ];
    expect(revampUiSource).not.toMatch(
      new RegExp(`function\\s+(${staleHelperNames.join("|")})\\b`),
    );
    expect(revampUiSource).not.toContain("TOOL_DISPLAY" + "_NAMES");
    expect(revampUiSource).not.toContain("trTool" + "Val");
    expect(gallerySource).not.toContain("doc" + "Suggestion");
  });
});

describe("chatUnified.css", () => {
  it("所有 .u-* 组件选择器都限定在 .u-scope 下", () => {
    expect(cssText).not.toMatch(/(^|\n)\s*(?:button\.)?\.u-(?!scope\b)[\w-]+/);
    expect(cssText).not.toMatch(/(^|\n)\s*:root\[data-perf="low"\]\s+\.u-/);
  });
});
