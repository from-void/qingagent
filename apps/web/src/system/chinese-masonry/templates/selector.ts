import type {
  ArticleData,
  SelectCallOptions,
  SelectorOptions,
  TemplateDefinition,
} from './types';
import { isPureChineseText } from '../utils';
import { calculateTemplateTextCapacity } from './capacity';
import { TemplateRegistry } from './registry';

export interface TemplateSelector {
  select: (article: ArticleData, options?: SelectCallOptions) => TemplateDefinition;
  score: (article: ArticleData, template: TemplateDefinition) => number;
}

export function createTemplateSelector(
  registry: TemplateRegistry,
  options: SelectorOptions = {},
): TemplateSelector {
  const random = options.random ?? Math.random;
  const allowFallback = options.allowFallback ?? true;
  const templateFilter = options.templateFilter;

  function score(article: ArticleData, template: TemplateDefinition): number {
    const titleLength = article.title.trim().length;
    const descriptionLength = article.description?.trim().length ?? 0;
    const pureChinese = isPureChineseText(article.title);
    const textCapacity = template.meta.textCapacity ?? calculateTemplateTextCapacity(template);
    let value = Math.max(0.1, template.meta.weight);

    if (template.meta.minTitleLength && titleLength < template.meta.minTitleLength) return 0;
    if (textCapacity.title && titleLength > textCapacity.title.maxCharacters) return 0;
    if (template.meta.maxTitleLength && titleLength > template.meta.maxTitleLength) return 0;
    if (template.meta.requiresImage && !article.imageUrl) return 0;

    const hasDynamicImage = template.elements.some(
      (element) => element.type === 'image' && element.source === 'dynamic',
    );
    if (article.imageUrl && hasDynamicImage) value *= 1.4;

    if (template.meta.preferVerticalText) {
      value *= pureChinese ? 2.4 : 0.3;
      if (titleLength <= 6) value *= 1.8;
    } else if (titleLength <= 6) {
      value *= 1.15;
    }

    if (titleLength > 12 && !template.meta.preferVerticalText) value *= 1.35;
    if (textCapacity.title && titleLength <= textCapacity.title.maxCharacters * 0.65) value *= 1.08;
    if (textCapacity.description && descriptionLength > 0) {
      if (descriptionLength <= textCapacity.description.maxCharacters) {
        value *= 1.08;
      } else {
        value *= Math.max(0.35, textCapacity.description.maxCharacters / descriptionLength);
      }
    }
    if (article.category && article.category === template.meta.category) value *= 1.3;
    if (article.tags?.some((tag) => template.meta.tags.includes(tag))) value *= 1.2;

    return Number(value.toFixed(4));
  }

  function select(article: ArticleData, callOptions: SelectCallOptions = {}): TemplateDefinition {
    const excluded = new Set([
      ...(options.excludeTemplateIds ?? []),
      ...(callOptions.excludeTemplateIds ?? []),
    ]);

    const allTemplates = registry.getAll();
    const scored = allTemplates
      .map((template) => ({ template, score: score(article, template) }))
      .filter((entry) => entry.score > 0);

    const filtered = templateFilter
      ? scored.filter((entry) => templateFilter(article, entry.template))
      : scored;

    const eligible = filtered.filter((entry) => !excluded.has(entry.template.id));
    // Fallback chain: eligible → filtered (ignoring excludeTemplateIds) → empty.
    // We intentionally do NOT fall back to `scored` (pre-filter) because that
    // would bypass the templateFilter. The last-resort block below handles
    // the case where both eligible and filtered are empty.
    let pool = eligible.length > 0 ? eligible : allowFallback ? filtered : [];

    // Last-resort fallback: when all templates scored 0 (e.g. title exceeds
    // every template's capacity), pick the templates with the largest title
    // capacity so the text has the best chance of fitting visually.
    if (pool.length === 0 && allowFallback && allTemplates.length > 0) {
      const withCapacity = allTemplates
        .filter((t) => !templateFilter || templateFilter(article, t))
        .map((template) => {
          const cap = template.meta.textCapacity?.title?.maxCharacters
            ?? template.meta.maxTitleLength ?? 0;
          return { template, score: cap };
        })
        .sort((a, b) => b.score - a.score);

      const candidates = withCapacity.length > 0 ? withCapacity : allTemplates
        .map((template) => {
          const cap = template.meta.textCapacity?.title?.maxCharacters
            ?? template.meta.maxTitleLength ?? 0;
          return { template, score: cap };
        })
        .sort((a, b) => b.score - a.score);

      pool = candidates.slice(0, 10);
    }

    if (pool.length === 0) {
      throw new Error('No template can render this article.');
    }

    const total = pool.reduce((sum, entry) => sum + entry.score, 0);
    let cursor = random() * total;

    for (const entry of pool) {
      cursor -= entry.score;
      if (cursor <= 0) return entry.template;
    }

    return pool[pool.length - 1]!.template;
  }

  return { select, score };
}
