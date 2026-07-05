import { useState } from 'react';
import { CardRenderer } from '../CardRenderer';
import { getHorizontalTextLayout, getVerticalTextLayout } from '../CardRenderer/verticalText';
import type { ArticleData, TemplateDefinition, TemplateElement } from '../../templates/types';
import { beginPointerSession } from './hooks/useDragResize';
import { useEditorStore } from './store';

interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AlignmentGuides {
  vertical: number[];
  horizontal: number[];
}

interface SnapResult {
  distance: number;
  delta: number;
  guide: number;
}

const SNAP_DISTANCE = 6;

function getElementBox(element: TemplateElement, sampleArticle: ArticleData) {
  if (element.type === 'text' && element.direction === 'vertical') {
    const text =
      element.content ??
      (element.role === 'title' ? sampleArticle.title : element.role === 'description' ? sampleArticle.description ?? '' : '');
    const layout = getVerticalTextLayout(text, element, element.lineHeight ?? 1.6);
    return {
      x: element.x + layout.xOffset,
      y: element.y,
      width: layout.width,
      height: element.height,
    };
  }
  if (element.type === 'text' && element.direction === 'horizontal') {
    return {
      x: element.x,
      y: element.y,
      width: element.width,
      height: getHorizontalTextLayout(element).height,
    };
  }
  if (element.type === 'line') {
    return {
      x: element.x,
      y: element.y,
      width: element.direction === 'horizontal' ? element.length : element.thickness,
      height: element.direction === 'horizontal' ? element.thickness : element.length,
    };
  }
  return {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
  };
}

function getGuideCandidates(template: TemplateDefinition, activeId: string, sampleArticle: ArticleData) {
  const vertical = [0, template.width / 2, template.width];
  const horizontal = [0, template.height / 2, template.height];

  template.elements.forEach((element) => {
    if (element.id === activeId) return;
    const box = getElementBox(element, sampleArticle);
    vertical.push(box.x, box.x + box.width / 2, box.x + box.width);
    horizontal.push(box.y, box.y + box.height / 2, box.y + box.height);
  });

  return { vertical, horizontal };
}

function findSnap(points: number[], candidates: number[]): SnapResult | null {
  let best: SnapResult | null = null;
  points.forEach((point) => {
    candidates.forEach((candidate) => {
      const delta = candidate - point;
      const distance = Math.abs(delta);
      if (distance > SNAP_DISTANCE) return;
      if (!best || distance < best.distance) {
        best = { distance, delta, guide: candidate };
      }
    });
  });
  return best;
}

function computeSnappedMove(
  template: TemplateDefinition,
  sampleArticle: ArticleData,
  activeId: string,
  dx: number,
  dy: number,
) {
  const element = template.elements.find((item) => item.id === activeId);
  if (!element) return null;

  const box = getElementBox(element, sampleArticle);
  const nextBox: ElementBox = { ...box, x: box.x + dx, y: box.y + dy };
  const candidates = getGuideCandidates(template, activeId, sampleArticle);
  const verticalSnap = findSnap(
    [nextBox.x, nextBox.x + nextBox.width / 2, nextBox.x + nextBox.width],
    candidates.vertical,
  );
  const horizontalSnap = findSnap(
    [nextBox.y, nextBox.y + nextBox.height / 2, nextBox.y + nextBox.height],
    candidates.horizontal,
  );
  const adjustedDx = dx + (verticalSnap?.delta ?? 0);
  const adjustedDy = dy + (horizontalSnap?.delta ?? 0);
  const guides: AlignmentGuides = {
    vertical: verticalSnap ? [verticalSnap.guide] : [],
    horizontal: horizontalSnap ? [horizontalSnap.guide] : [],
  };

  return {
    x: element.x + adjustedDx,
    y: element.y + adjustedDy,
    guides,
  };
}

interface CanvasProps {
  selectionChromeHidden?: boolean;
}

export function Canvas({ selectionChromeHidden = false }: CanvasProps) {
  const template = useEditorStore((state) => state.template);
  const selectedId = useEditorStore((state) => state.selectedId);
  const sampleArticle = useEditorStore((state) => state.sampleArticle);
  const fontConfig = useEditorStore((state) => state.fontConfig);
  const selectElement = useEditorStore((state) => state.selectElement);
  const recordHistory = useEditorStore((state) => state.recordHistory);
  const moveElementTo = useEditorStore((state) => state.moveElementTo);
  const resizeElement = useEditorStore((state) => state.resizeElement);
  const resizeCardHeight = useEditorStore((state) => state.resizeCardHeight);
  const [guides, setGuides] = useState<AlignmentGuides | null>(null);
  const selectedElement = template.elements.find((element) => element.id === selectedId);
  const box = selectedElement ? getElementBox(selectedElement, sampleArticle) : null;

  return (
    <section className="cm-editor-canvas" aria-label="模板画布">
      <div className="cm-editor-canvas-grid" />
      <div
        className="cm-editor-canvas-card"
        style={{ width: template.width, height: template.height }}
        onClick={() => selectElement(null)}
      >
        <CardRenderer
          article={sampleArticle}
          template={template}
          fontConfig={fontConfig}
          editorMode
          selectedElementId={selectionChromeHidden ? null : selectedId}
          onSelectElement={selectElement}
          onElementPointerDown={(id, event) => {
            setGuides(null);
            beginPointerSession({
              event,
              onStart: recordHistory,
              onMove: (dx, dy) => {
                const state = useEditorStore.getState();
                const snapped = computeSnappedMove(state.template, state.sampleArticle, id, dx, dy);
                if (!snapped) return;
                setGuides(snapped.guides.vertical.length || snapped.guides.horizontal.length ? snapped.guides : null);
                moveElementTo(id, snapped.x, snapped.y);
              },
              onEnd: () => setGuides(null),
            });
          }}
        />
        {guides?.vertical.map((x) => (
          <div key={`v-${x}`} className="cm-editor-guide cm-editor-guide-vertical" style={{ left: x }} />
        ))}
        {guides?.horizontal.map((y) => (
          <div key={`h-${y}`} className="cm-editor-guide cm-editor-guide-horizontal" style={{ top: y }} />
        ))}
        {!selectionChromeHidden && selectedElement && box ? (
          <button
            type="button"
            aria-label="调整元素大小"
            className="cm-editor-resize-handle"
            style={{
              left: box.x + box.width - 6,
              top: box.y + box.height - 6,
            }}
            onPointerDown={(event) => {
              beginPointerSession({
                event,
                onStart: recordHistory,
                onMove: (dx, dy) => resizeElement(selectedElement.id, dx, dy),
              });
            }}
          />
        ) : null}
        <button
          type="button"
          aria-label={'\u8c03\u6574\u753b\u5e03\u9ad8\u5ea6'}
          className="cm-editor-card-height-handle"
          style={{
            left: template.width / 2 - 24,
            top: template.height - 6,
          }}
          onPointerDown={(event) => {
            beginPointerSession({
              event,
              onStart: recordHistory,
              onMove: (_dx, dy) => resizeCardHeight(dy),
            });
          }}
        />
      </div>
      <div className="cm-editor-canvas-size">
        {template.width} x {template.height}px
      </div>
    </section>
  );
}
