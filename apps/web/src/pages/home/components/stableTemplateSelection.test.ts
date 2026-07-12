import {
  createDefaultRegistry,
  createTemplateSelector,
  type ArticleData,
  type SelectorOptions,
} from "../../../system/chinese-masonry";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HomeSession } from "../data/sessions";
import { qingagentTemplateFilter } from "./masonryAdapters";
import {
  buildHomeCardEntries,
  pickStableTemplate,
  type HomeCardEntry,
} from "./stableTemplateSelection";

const selectorOptions: SelectorOptions = {
  allowFallback: true,
  templateFilter: qingagentTemplateFilter,
};

const sessions: HomeSession[] = [
  {
    id: "article-short-chinese",
    title: "山行",
    brief: "远上寒山石径斜，白云生处有人家。",
    imageUrl: null,
    ghostLines: [{ width: 95 }],
    sources: [{ kind: "md", tip: "短篇" }],
    date: "今天",
    category: "short",
    recentEditedAt: 300,
    createdAt: 100,
    pushedAt: 300,
  },
  {
    id: "article-long-english",
    title: "Designing a resilient knowledge workflow",
    brief: "A long-form field note with English text and a deliberately different content profile.",
    imageUrl: null,
    ghostLines: [{ width: 88 }],
    sources: [{ kind: "web", tip: "网页" }],
    date: "昨天",
    category: "knowledge",
    recentEditedAt: 200,
    createdAt: 90,
    pushedAt: 200,
  },
  {
    id: "article-image-note",
    title: "春江花月夜图记",
    brief: "有图长文，用于覆盖图片、分类与标签参与候选池打分的路径。",
    imageUrl: "/fixtures/spring-river.jpg",
    ghostLines: [{ width: 82 }],
    sources: [{ kind: "png", tip: "配图" }],
    date: "三天前",
    category: "image",
    recentEditedAt: 100,
    createdAt: 80,
    pushedAt: 100,
  },
];

function templateMapping(entries: HomeCardEntry[]): Record<string, string> {
  return Object.fromEntries(
    entries
      .filter((entry) => entry.kind === "real")
      .map((entry) => [entry.id, entry.template!.id] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("首页稳定模板选择", () => {
  it("同一 article 多次重建 selector 时选择同一模板，且不读取 Math.random", () => {
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("生产路径不应读取默认随机源");
    });
    const registry = createDefaultRegistry();
    const article: ArticleData = {
      id: "stable-article",
      title: "同一篇青简",
      description: "同一 article、注册表与算法版本下应保持模板稳定。",
      category: "long",
      tags: ["md"],
    };

    const templateIds = Array.from({ length: 5 }, () =>
      pickStableTemplate(registry, article, selectorOptions).id,
    );

    expect(new Set(templateIds)).toEqual(new Set([templateIds[0]]));
  });

  it("生产 entries builder 在重建及 sessions 排序变化后保持 id 到模板映射稳定", () => {
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("生产路径不应读取默认随机源");
    });
    const registry = createDefaultRegistry();
    const selectCallOptions: unknown[] = [];
    const countingFactory: typeof createTemplateSelector = (activeRegistry, options) => {
      const selector = createTemplateSelector(activeRegistry, options);
      return {
        score: selector.score,
        select: (article, callOptions) => {
          selectCallOptions.push(callOptions);
          return selector.select(article, callOptions);
        },
      };
    };
    const build = (activeSessions: HomeSession[]) =>
      buildHomeCardEntries({
        sessions: activeSessions,
        registry,
        selectorOptions,
        reviewAll: false,
        newCardHeight: 380,
        now: () => 1_000,
        selectorFactory: countingFactory,
      });

    const firstMount = build(sessions);
    expect(firstMount[0]?.id).toBe("__qj_new__");
    expect(selectCallOptions).toHaveLength(sessions.length);
    expect(selectCallOptions).toEqual(sessions.map(() => undefined));

    selectCallOptions.length = 0;
    const remount = build(sessions);
    expect(remount[0]?.id).toBe("__qj_new__");
    expect(selectCallOptions).toHaveLength(sessions.length);

    selectCallOptions.length = 0;
    const reorderedSessions = [...sessions]
      .reverse()
      .map((session, index) => ({ ...session, recentEditedAt: (index + 1) * 1_000 }));
    const reordered = build(reorderedSessions);
    expect(reordered[0]?.id).toBe("__qj_new__");
    expect(selectCallOptions).toHaveLength(sessions.length);

    expect(templateMapping(remount)).toEqual(templateMapping(firstMount));
    expect(templateMapping(reordered)).toEqual(templateMapping(firstMount));
  });

  it("mock entries 按注册表 index 轮播，selector 调用为零且新建卡恒在首位", () => {
    const registry = createDefaultRegistry();
    let selectorFactoryCalls = 0;
    let selectorCalls = 0;
    const countingFactory: typeof createTemplateSelector = (activeRegistry) => {
      selectorFactoryCalls += 1;
      return {
        score: () => 1,
        select: () => {
          selectorCalls += 1;
          return activeRegistry.getAll()[0]!;
        },
      };
    };

    const entries = buildHomeCardEntries({
      sessions,
      registry,
      selectorOptions,
      reviewAll: true,
      newCardHeight: 380,
      now: () => 1_000,
      selectorFactory: countingFactory,
    });

    expect(entries[0]?.id).toBe("__qj_new__");
    expect(selectorFactoryCalls).toBe(0);
    expect(selectorCalls).toBe(0);
    expect(entries.slice(1).map((entry) => entry.template?.id)).toEqual(
      registry.getAll().slice(0, sessions.length).map((template) => template.id),
    );
  });
});
