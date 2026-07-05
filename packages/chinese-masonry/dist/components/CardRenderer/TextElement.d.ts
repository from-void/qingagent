import { ArticleData, GlobalFontConfig, TextElement as TextElementType } from '../../templates/types';
interface TextElementProps {
    element: TextElementType;
    article: ArticleData;
    fontConfig: GlobalFontConfig;
    colorOverride?: string;
    selected?: boolean;
    editorMode?: boolean;
    onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onClick?: () => void;
}
export declare function TextElement({ element, article, fontConfig, colorOverride, selected, editorMode, onPointerDown, onClick, }: TextElementProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=TextElement.d.ts.map