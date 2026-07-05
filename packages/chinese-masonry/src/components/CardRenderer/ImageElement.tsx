import type { CSSProperties } from 'react';
import type { ArticleData, ImageElement as ImageElementType } from '../../templates/types';

interface ImageElementProps {
  element: ImageElementType;
  article: ArticleData;
  selected?: boolean;
  editorMode?: boolean;
  filter?: string;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onClick?: () => void;
}

export function ImageElement({
  element,
  article,
  selected = false,
  editorMode = false,
  filter,
  onPointerDown,
  onClick,
}: ImageElementProps) {
  const src = element.source === 'dynamic' ? article.imageUrl : element.staticUrl;
  if (!src && !editorMode) return null;

  const wrapperStyle: CSSProperties = {
    position: 'absolute',
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    zIndex: element.zIndex ?? 1,
    clipPath: element.shape === 'trapezoid' ? element.clipPath : undefined,
    overflow: 'hidden',
    opacity: element.opacity,
    cursor: editorMode ? 'move' : undefined,
    outline: selected ? '1px dashed rgba(42,80,128,.85)' : undefined,
    outlineOffset: 2,
    background: editorMode && !src ? 'rgba(42,80,128,.08)' : undefined,
    filter,
    transition: filter ? 'filter 400ms ease' : undefined,
  };

  const imageStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: element.objectFit ?? 'cover',
    objectPosition: element.objectPosition,
    display: 'block',
    clipPath: element.shape === 'trapezoid' ? element.clipPath : undefined,
  };

  return (
    <div
      className="cm-image"
      data-testid={`cm-image-${element.id}`}
      style={wrapperStyle}
      onPointerDown={onPointerDown}
      onClick={(event) => {
        if (editorMode) event.stopPropagation();
        onClick?.();
      }}
    >
      {src ? (
        <img src={src} alt={article.title} style={imageStyle} loading="lazy" />
      ) : (
        <span className="cm-image-placeholder">{element.source === 'dynamic' ? '首图' : '背景图'}</span>
      )}
    </div>
  );
}
