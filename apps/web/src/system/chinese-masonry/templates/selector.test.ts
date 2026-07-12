import { describe, expect, it } from 'vitest';
import { defaultTemplates } from './defaults';
import { TemplateRegistry } from './registry';
import { createTemplateSelector } from './selector';
import type { ArticleData } from './types';

function createRegistry() {
  const registry = new TemplateRegistry();
  defaultTemplates.forEach((template) => registry.register(template));
  return registry;
}

describe('TemplateSelector', () => {
  it('filters image-only templates when the article has no image', () => {
    const registry = createRegistry();
    const selector = createTemplateSelector(registry, { random: () => 0 });
    const article: ArticleData = {
      id: 'no-image',
      title: '荷塘月色',
      description: '今晚在院子里坐着乘凉。',
    };

    const selected = selector.select(article);

    expect(selected.meta.requiresImage).toBe(false);
  });

  it('boosts vertical templates for short pure Chinese titles', () => {
    const registry = createRegistry();
    const selector = createTemplateSelector(registry, { random: () => 0.99 });
    const article: ArticleData = {
      id: 'poem',
      title: '静夜思',
      description: '床前明月光，疑是地上霜。',
    };

    const verticalScore = selector.score(article, registry.get('curated-cuiniao-vertical')!);
    const horizontalScore = selector.score(article, registry.get('curated-shanshui-blank')!);

    expect(verticalScore).toBeGreaterThan(horizontalScore);
  });

  it('penalizes vertical templates for titles with latin characters', () => {
    const registry = createRegistry();
    const selector = createTemplateSelector(registry, { random: () => 0.8 });
    const article: ArticleData = {
      id: 'mixed-title',
      title: 'AI 与宋词的关系',
      description: '一个带有英文字符的标题。',
    };

    const selected = selector.select(article);

    expect(selected.id).not.toBe('curated-cuiniao-vertical');
  });

  it('can exclude the previous template to avoid adjacent repetition', () => {
    const registry = createRegistry();
    const selector = createTemplateSelector(registry, { random: () => 0 });
    const article: ArticleData = {
      id: 'second',
      title: '春江花月夜',
      description: '春江潮水连海平。',
      imageUrl: 'https://example.com/image.jpg',
    };

    const selected = selector.select(article, { excludeTemplateIds: ['curated-shanshui-blank'] });

    expect(selected.id).not.toBe('curated-shanshui-blank');
  });

  it('uses calculated title capacity to reject templates that cannot fit the title', () => {
    const registry = createRegistry();
    const selector = createTemplateSelector(registry, { random: () => 0 });
    const article: ArticleData = {
      id: 'long-title',
      title: '这是一个明显超过十个字的标题',
      description: '简短摘要。',
    };

    expect(registry.get('curated-shanshui-blank')?.meta.textCapacity?.title?.maxCharacters).toBe(10);
    expect(selector.score(article, registry.get('curated-shanshui-blank')!)).toBe(0);
  });
});
