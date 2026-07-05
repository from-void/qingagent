import type { CSSProperties } from 'react';
import type {
  ArticleData,
  GlobalFontConfig,
  MasonryColorConfig,
  SelectorOptions,
} from '../../templates/types';
import type { TemplateRegistry } from '../../templates/registry';

export interface ChineseMasonryProps {
  items: ArticleData[];
  columnGutter?: number;
  rowGutter?: number;
  registry?: TemplateRegistry;
  selectorOptions?: SelectorOptions;
  templateId?: string;
  fontConfig?: GlobalFontConfig;
  colorConfig?: MasonryColorConfig;
  onItemClick?: (item: ArticleData) => void;
  className?: string;
  style?: CSSProperties;
}
