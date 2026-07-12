import type { CSSProperties } from 'react';
import type { ArticleData, GlobalFontConfig, TextElement as TextElementType } from '../../templates/types';
import { getHorizontalTextLayout, getVerticalTextLayout } from './verticalText';

interface TextElementProps {
  element: TextElementType;
  article: ArticleData;
  fontConfig: GlobalFontConfig;
  colorOverride?: string;
  selected?: boolean;
  editorMode?: boolean;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onClick?: () => void;
}

export function TextElement({
  element,
  article,
  fontConfig,
  colorOverride,
  selected = false,
  editorMode = false,
  onPointerDown,
  onClick,
}: TextElementProps) {
  const text =
    element.content ??
    (element.role === 'title' ? article.title : element.role === 'description' ? article.description ?? '' : '');
  const lineHeight = element.lineHeight ?? 1.6;
  const fontFamily = element.role === 'description' ? fontConfig.descriptionFont : fontConfig.titleFont;
  const verticalLayout = element.direction === 'vertical' ? getVerticalTextLayout(text, element, lineHeight) : null;
  const horizontalLayout = element.direction === 'horizontal' ? getHorizontalTextLayout(element) : null;
  const displayText = verticalLayout?.text ?? text;
  const shouldBottomAlign = element.direction === 'horizontal' && element.blockAlign === 'end';

  const style: CSSProperties = {
    position: 'absolute',
    left: element.x + (verticalLayout?.xOffset ?? 0),
    top: element.y,
    width: verticalLayout?.width ?? element.width,
    height: verticalLayout ? element.height : horizontalLayout?.height,
    color: colorOverride ?? element.color,
    fontFamily,
    fontSize: element.fontSize,
    fontWeight: element.fontWeight ?? 'normal',
    letterSpacing: element.letterSpacing,
    lineHeight,
    textAlign: element.textAlign ?? 'left',
    zIndex: 20,
    cursor: editorMode ? 'move' : undefined,
    outline: selected ? '1px dashed rgba(160,48,32,.8)' : undefined,
    outlineOffset: 2,
  };

  if (element.direction === 'vertical') {
    style.writingMode = verticalLayout?.writingMode ?? 'vertical-rl';
    style.textOrientation = 'mixed';
    style.overflow = 'hidden';
    style.whiteSpace = 'normal';
  } else {
    style.display = 'flex';
    style.flexDirection = 'column';
    style.justifyContent = shouldBottomAlign ? 'flex-end' : 'flex-start';
    style.overflow = 'hidden';
  }

  const textContentStyle: CSSProperties | undefined =
    element.direction === 'horizontal'
      ? {
          display: '-webkit-box',
          WebkitLineClamp: element.maxLines,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }
      : undefined;

  return (
    <div
      className={`cm-text cm-text-${element.role}`}
      data-testid={`cm-text-${element.id}`}
      style={style}
      onPointerDown={onPointerDown}
      onClick={(event) => {
        if (editorMode) event.stopPropagation();
        onClick?.();
      }}
    >
      <span style={textContentStyle}>
        {displayText || (editorMode ? `${element.role === 'title' ? '标题' : '摘要'}占位符` : null)}
      </span>
    </div>
  );
}
