import { TemplateDefinition } from './types';
type LazyLoader = () => Promise<TemplateDefinition>;
export declare class TemplateRegistry {
    private templates;
    private lazyLoaders;
    private loading;
    constructor(initialTemplates?: TemplateDefinition[]);
    register(template: TemplateDefinition): void;
    registerLazy(id: string, loader: LazyLoader): void;
    get(id: string): TemplateDefinition | undefined;
    load(id: string): Promise<TemplateDefinition>;
    getAll(): TemplateDefinition[];
    getByCategory(category: string): TemplateDefinition[];
    remove(id: string): boolean;
}
export declare function createDefaultRegistry(): TemplateRegistry;
export {};
//# sourceMappingURL=registry.d.ts.map