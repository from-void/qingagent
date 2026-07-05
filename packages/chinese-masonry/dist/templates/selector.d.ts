import { ArticleData, SelectCallOptions, SelectorOptions, TemplateDefinition } from './types';
import { TemplateRegistry } from './registry';
export interface TemplateSelector {
    select: (article: ArticleData, options?: SelectCallOptions) => TemplateDefinition;
    score: (article: ArticleData, template: TemplateDefinition) => number;
}
export declare function createTemplateSelector(registry: TemplateRegistry, options?: SelectorOptions): TemplateSelector;
//# sourceMappingURL=selector.d.ts.map