import { CSSProperties } from 'react';
import { ArticleData, GlobalFontConfig, MasonryColorConfig, SelectorOptions } from '../../templates/types';
import { TemplateRegistry } from '../../templates/registry';
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
//# sourceMappingURL=types.d.ts.map