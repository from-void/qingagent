import type { CSSProperties } from 'react';
import type { LineElement as LineElementType } from '../../templates/types';

interface LineElementProps {
  element: LineElementType;
  selected?: boolean;
  editorMode?: boolean;
  colorOverride?: string;
  filter?: string;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onClick?: () => void;
}

export function LineElement({
  element,
  selected = false,
  editorMode = false,
  colorOverride,
  filter,
  onPointerDown,
  onClick,
}: LineElementProps) {
  const style: CSSProperties = {
    position: 'absolute',
    left: element.x,
    top: element.y,
    width: element.direction === 'horizontal' ? element.length : element.thickness,
    height: element.direction === 'horizontal' ? element.thickness : element.length,
    background: colorOverride ?? element.color,
    zIndex: element.zIndex ?? 10,
    filter,
    cursor: editorMode ? 'move' : undefined,
    outline: selected ? '1px dashed rgba(184,134,11,.9)' : undefined,
    outlineOffset: 3,
  };
  const className = ['cm-line', editorMode ? 'cm-line-editor' : '', selected ? 'cm-line-selected' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      data-testid={`cm-line-${element.id}`}
      style={style}
      onPointerDown={onPointerDown}
      onClick={(event) => {
        if (editorMode) event.stopPropagation();
        onClick?.();
      }}
    >
      {editorMode ? <span className="cm-line-hit-area" aria-hidden="true" /> : null}
    </div>
  );
}
