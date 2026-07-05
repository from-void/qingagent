import { ArticleData, ImageElement as ImageElementType } from '../../templates/types';
interface ImageElementProps {
    element: ImageElementType;
    article: ArticleData;
    selected?: boolean;
    editorMode?: boolean;
    filter?: string;
    onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onClick?: () => void;
}
export declare function ImageElement({ element, article, selected, editorMode, filter, onPointerDown, onClick, }: ImageElementProps): import("react/jsx-runtime").JSX.Element | null;
export {};
//# sourceMappingURL=ImageElement.d.ts.map