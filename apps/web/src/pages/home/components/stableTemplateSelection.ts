import {
  createTemplateSelector,
  type ArticleData,
  type SelectorOptions,
  type TemplateDefinition,
  type TemplateRegistry,
} from "chinese-masonry";
import type { HomeSession } from "../data/sessions";
import { hashSeed, makeRng } from "./inkBrush";
import { homeSessionToArticle } from "./masonryAdapters";

export interface HomeCardEntry {
  kind: "new" | "real";
  id: string;
  article?: ArticleData;
  template?: TemplateDefinition;
  height: number;
  date: string;
  createdAt: number;
  title: string;
  brief: string;
  category: string;
}

type SelectorFactory = typeof createTemplateSelector;

interface BuildHomeCardEntriesOptions {
  sessions: HomeSession[];
  registry: TemplateRegistry;
  selectorOptions: SelectorOptions;
  reviewAll: boolean;
  newCardHeight: number;
  now?: () => number;
  selectorFactory?: SelectorFactory;
}

/**
 * 同一 article、模板注册表和选择算法版本下，始终选中同一模板。
 * 候选池仍由 article 内容打分决定；id 种子只决定池内的加权选择位置。
 */
export function pickStableTemplate(
  registry: TemplateRegistry,
  article: ArticleData,
  selectorOptions: SelectorOptions,
  selectorFactory: SelectorFactory = createTemplateSelector,
): TemplateDefinition {
  // selector 成功路径只读取一次 random；固定为单值，避免复用有状态 RNG 后选择漂移。
  const unit = makeRng(hashSeed(article.id))();
  const selector = selectorFactory(registry, {
    ...selectorOptions,
    random: () => unit,
  });
  return selector.select(article);
}

export function buildHomeCardEntries({
  sessions,
  registry,
  selectorOptions,
  reviewAll,
  newCardHeight,
  now = Date.now,
  selectorFactory = createTemplateSelector,
}: BuildHomeCardEntriesOptions): HomeCardEntry[] {
  // 模板预览模式按注册表顺序轮播全部模板，不经过 selector。
  const allTemplates = reviewAll ? registry.getAll() : [];
  const sorted = [...sessions].sort((a, b) => b.recentEditedAt - a.recentEditedAt);
  const realEntries: HomeCardEntry[] = sorted.map((session, index) => {
    const article = homeSessionToArticle(session);
    const template =
      reviewAll && allTemplates.length > 0
        ? allTemplates[index % allTemplates.length]!
        : pickStableTemplate(registry, article, selectorOptions, selectorFactory);

    return {
      kind: "real",
      id: session.id,
      article,
      template,
      height: template.height,
      date: session.date,
      createdAt: session.createdAt,
      title: session.title,
      brief: session.brief,
      category: String(session.category ?? ""),
    };
  });

  const newCard: HomeCardEntry = {
    kind: "new",
    id: "__qj_new__",
    height: newCardHeight,
    date: "",
    createdAt: now() / 1000,
    title: "新建文档",
    brief: "",
    category: "",
  };
  return [newCard, ...realEntries];
}
