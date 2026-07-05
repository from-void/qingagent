import type { CSSProperties } from 'react';
import { DEFAULT_FONT_CONFIG } from '../../constants';
import type { CardRendererProps, GlobalFontConfig, TemplateElement } from '../../templates/types';
import { normalizeColorConfig } from '../../utils';
import { ImageElement } from './ImageElement';
import { LineElement } from './LineElement';
import { TextElement } from './TextElement';

interface EditableRendererProps extends CardRendererProps {
  editorMode?: boolean;
  selectedElementId?: string | null;
  onSelectElement?: (id: string) => void;
  onElementPointerDown?: (id: string, event: React.PointerEvent<HTMLDivElement>) => void;
}

function elementOrder(element: TemplateElement): number {
  if (element.type === 'image') return element.zIndex ?? 1;
  if (element.type === 'line') return element.zIndex ?? 10;
  return 20;
}

export function CardRenderer({
  article,
  template,
  fontConfig,
  colorConfig,
  className,
  style,
  onClick,
  editorMode = false,
  selectedElementId,
  onSelectElement,
  onElementPointerDown,
}: EditableRendererProps) {
  const mergedFontConfig: GlobalFontConfig = {
    ...DEFAULT_FONT_CONFIG,
    ...fontConfig,
  };
  const normalizedColor = normalizeColorConfig(colorConfig);
  const nonTextFilter = normalizedColor.enabled
    ? `grayscale(${normalizedColor.grayscale}) sepia(${normalizedColor.sepia})`
    : undefined;

  const rootStyle: CSSProperties = {
    width: template.width,
    height: template.height,
    position: 'relative',
    overflow: 'hidden',
    // borderRadius is controlled by CSS (.cm-card) — no inline override
    background: template.backgroundColor ?? '#f5f0e8',
    // boxShadow is controlled by CSS (.cm-card / .cm-card:hover) — no inline override
    transition: `transform 220ms ease, box-shadow 220ms ease`,
    cursor: onClick ? 'pointer' : undefined,
    ...style,
  };

  const sortedElements = [...template.elements].sort((a, b) => elementOrder(a) - elementOrder(b));

  return (
    <article
      className={`cm-card ${className ?? ''}`}
      data-template-id={template.id}
      data-article-id={article.id}
      data-testid="cm-card"
      style={rootStyle}
      onClick={() => onClick?.(article)}
    >
      {sortedElements.map((element) => {
        const selected = selectedElementId === element.id;
        const common = {
          selected,
          editorMode,
          onClick: () => onSelectElement?.(element.id),
          onPointerDown: (event: React.PointerEvent<HTMLDivElement>) =>
            onElementPointerDown?.(element.id, event),
        };

        if (element.type === 'image') {
          return (
            <ImageElement
              key={element.id}
              element={element}
              article={article}
              filter={editorMode ? undefined : nonTextFilter}
              {...common}
            />
          );
        }
        if (element.type === 'line') {
          return (
            <LineElement
              key={element.id}
              element={element}
              colorOverride={normalizedColor.enabled ? normalizedColor.lineColor : undefined}
              filter={editorMode ? undefined : nonTextFilter}
              {...common}
            />
          );
        }
        return (
          <TextElement
            key={element.id}
            element={element}
            article={article}
            fontConfig={mergedFontConfig}
            colorOverride={normalizedColor.enabled ? normalizedColor.textColor : undefined}
            {...common}
          />
        );
      })}
      {normalizedColor.enabled && !editorMode ? (
        <div
          className="cm-card-color-overlay"
          data-testid="cm-card-color-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 15,
            pointerEvents: 'none',
            background: normalizedColor.overlayColor,
            // opacity is controlled by CSS (.cm-card-color-overlay / .cm-card:hover .cm-card-color-overlay)
            // Using a CSS custom property so the CSS rule can override on hover
            '--cm-overlay-opacity': normalizedColor.overlayOpacity,
            transition: `opacity ${normalizedColor.transitionDuration}ms ease`,
          } as CSSProperties}
        />
      ) : null}
    </article>
  );
}
