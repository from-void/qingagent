import { useEffect, useMemo, useRef, useState } from 'react';
import { Masonry } from 'masonic';
import {
  CARD_WIDTH,
  DEFAULT_COLUMN_GUTTER,
  DEFAULT_ROW_GUTTER,
} from '../../constants';
import { CardRenderer } from '../CardRenderer';
import { createDefaultRegistry } from '../../templates/registry';
import { createTemplateSelector } from '../../templates/selector';
import type { ArticleData, TemplateDefinition } from '../../templates/types';
import { calculateMasonryMetrics } from '../../utils';
import type { ChineseMasonryProps } from './types';

interface RenderItem {
  article: ArticleData;
  template: TemplateDefinition;
}

export function ChineseMasonry({
  items,
  columnGutter = DEFAULT_COLUMN_GUTTER,
  rowGutter = DEFAULT_ROW_GUTTER,
  registry,
  selectorOptions,
  templateId,
  fontConfig,
  colorConfig,
  onItemClick,
  className,
  style,
}: ChineseMasonryProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const activeRegistry = useMemo(() => registry ?? createDefaultRegistry(), [registry]);
  const selector = useMemo(
    () => createTemplateSelector(activeRegistry, selectorOptions),
    [activeRegistry, selectorOptions],
  );

  const renderItems = useMemo<RenderItem[]>(() => {
    let previousId: string | undefined;
    return items.map((article) => {
      const forcedTemplate = templateId ? activeRegistry.get(templateId) : undefined;
      const template =
        forcedTemplate ?? selector.select(article, previousId ? { excludeTemplateIds: [previousId] } : undefined);
      previousId = template.id;
      return { article, template };
    });
  }, [activeRegistry, items, selector, templateId]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const updateWidth = (width: number) => {
      setContainerWidth(Math.max(0, Math.floor(width)));
    };

    updateWidth(node.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      updateWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const fallbackWidth = CARD_WIDTH * 3 + columnGutter * 2;
  const metrics = calculateMasonryMetrics(containerWidth || fallbackWidth, columnGutter);

  if (items.length === 0) {
    return <div className={`cm-empty ${className ?? ''}`}>暂无文章</div>;
  }

  return (
    <div
      ref={containerRef}
      className={`cm-masonry-root ${className ?? ''}`}
      style={{
        width: '100%',
        overflowX: 'auto',
        ...style,
      }}
    >
      <div
        className="cm-masonry-grid"
        style={{
          width: metrics.gridWidth,
          marginInline: 'auto',
        }}
      >
        <Masonry<RenderItem>
          items={renderItems}
          columnWidth={CARD_WIDTH}
          columnGutter={columnGutter}
          rowGutter={rowGutter}
          itemKey={(item) => item.article.id}
          render={({ data }) => (
            <CardRenderer
              article={data.article}
              template={data.template}
              fontConfig={fontConfig}
              colorConfig={colorConfig}
              onClick={onItemClick}
            />
          )}
        />
      </div>
    </div>
  );
}
