import { CardRendererProps } from '../../templates/types';
interface EditableRendererProps extends CardRendererProps {
    editorMode?: boolean;
    selectedElementId?: string | null;
    onSelectElement?: (id: string) => void;
    onElementPointerDown?: (id: string, event: React.PointerEvent<HTMLDivElement>) => void;
}
export declare function CardRenderer({ article, template, fontConfig, colorConfig, className, style, onClick, editorMode, selectedElementId, onSelectElement, onElementPointerDown, }: EditableRendererProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=index.d.ts.map