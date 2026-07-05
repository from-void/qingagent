import { ArticleData, GlobalFontConfig, TemplateDefinition, TemplateElement } from '../../templates/types';
export interface EditorStore {
    template: TemplateDefinition;
    selectedId: string | null;
    sampleArticle: ArticleData;
    fontConfig: GlobalFontConfig;
    past: TemplateDefinition[];
    future: TemplateDefinition[];
    exportedJson: string;
    loadTemplate: (template: TemplateDefinition, sampleArticle?: ArticleData) => void;
    createTemplate: () => void;
    selectElement: (id: string | null) => void;
    toggleContentElement: (role: 'hero' | 'title' | 'description' | 'stamp', visible: boolean) => void;
    addBackgroundImage: () => void;
    addLine: () => void;
    deleteElement: (id: string) => void;
    recordHistory: () => void;
    moveElement: (id: string, dx: number, dy: number) => void;
    moveElementTo: (id: string, x: number, y: number) => void;
    nudgeElement: (id: string, dx: number, dy: number) => void;
    resizeElement: (id: string, dx: number, dy: number) => void;
    resizeCardHeight: (dy: number) => void;
    updateElement: (id: string, patch: Partial<TemplateElement>) => void;
    updateCard: (patch: Partial<Pick<TemplateDefinition, 'height' | 'backgroundColor' | 'borderRadius'>>) => void;
    updateFontConfig: (patch: Partial<GlobalFontConfig>) => void;
    undo: () => void;
    redo: () => void;
    exportJson: () => void;
    importJson: (json: string) => void;
}
export declare const defaultSampleArticle: ArticleData;
export declare const useEditorStore: import('zustand').UseBoundStore<Omit<import('zustand').StoreApi<EditorStore>, "setState"> & {
    setState(nextStateOrUpdater: EditorStore | Partial<EditorStore> | ((state: import('immer').WritableDraft<EditorStore>) => void), shouldReplace?: boolean | undefined): void;
}>;
export declare function getSelectedElement(): TemplateElement | undefined;
//# sourceMappingURL=store.d.ts.map