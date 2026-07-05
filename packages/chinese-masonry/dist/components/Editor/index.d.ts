import { CSSProperties } from 'react';
import { ArticleData, TemplateDefinition } from '../../templates/types';
export interface TemplateEditorProps {
    initialTemplate: TemplateDefinition;
    sampleArticle?: ArticleData;
    onSave?: (template: TemplateDefinition) => void;
    onChange?: (template: TemplateDefinition) => void;
    className?: string;
    style?: CSSProperties;
}
export declare function TemplateEditor({ initialTemplate, sampleArticle, onSave, onChange, className, style, }: TemplateEditorProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=index.d.ts.map