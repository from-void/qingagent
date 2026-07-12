import './style.css';

export { CardRenderer } from './components/CardRenderer';

export { TemplateRegistry, createDefaultRegistry } from './templates/registry';
export { createTemplateSelector } from './templates/selector';
export { calculateTemplateTextCapacity, calculateTextCapacity, withTemplateTextCapacity } from './templates/capacity';
export { CARD_WIDTH } from './constants';

export type {
  ArticleData,
  CardRendererProps,
  GlobalFontConfig,
  ImageElement,
  LineElement,
  MasonryColorConfig,
  SelectorOptions,
  SelectCallOptions,
  TemplateDefinition,
  TemplateElement,
  TemplateMeta,
  TemplateTextCapacity,
  TextCapacityInfo,
  TextElement,
} from './templates/types';
