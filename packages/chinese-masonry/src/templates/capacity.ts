import type { TemplateDefinition, TemplateTextCapacity, TextCapacityInfo, TextElement } from './types';

function positiveInteger(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
}

export function calculateTextCapacity(element: TextElement): TextCapacityInfo {
  const fontSize = Math.max(1, element.fontSize);
  const letterSpacing = element.letterSpacing ?? 0;
  const lineHeight = element.lineHeight ?? 1.6;
  const charAdvance = Math.max(1, fontSize + letterSpacing);
  const maxLines = positiveInteger(element.maxLines, 1);

  if (element.direction === 'vertical') {
    const charactersPerColumn = Math.max(1, Math.floor(element.height / charAdvance));
    return {
      direction: 'vertical',
      maxCharacters: charactersPerColumn * maxLines,
      charactersPerColumn,
      columnCount: maxLines,
      fontSize,
      letterSpacing,
      lineHeight,
    };
  }

  const charactersPerLine = Math.max(1, Math.floor(element.width / charAdvance));
  return {
    direction: 'horizontal',
    maxCharacters: charactersPerLine * maxLines,
    charactersPerLine,
    lineCount: maxLines,
    fontSize,
    letterSpacing,
    lineHeight,
  };
}

export function calculateTemplateTextCapacity(template: TemplateDefinition): TemplateTextCapacity {
  const result: TemplateTextCapacity = {};
  const title = template.elements.find(
    (element): element is TextElement => element.type === 'text' && element.role === 'title',
  );
  const description = template.elements.find(
    (element): element is TextElement => element.type === 'text' && element.role === 'description',
  );

  if (title) result.title = calculateTextCapacity(title);
  if (description) result.description = calculateTextCapacity(description);
  return result;
}

export function withTemplateTextCapacity(template: TemplateDefinition): TemplateDefinition {
  const textCapacity = calculateTemplateTextCapacity(template);
  return {
    ...template,
    meta: {
      ...template.meta,
      maxTitleLength: textCapacity.title?.maxCharacters ?? template.meta.maxTitleLength,
      textCapacity,
    },
  };
}
