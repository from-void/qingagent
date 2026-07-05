import { LineElement as LineElementType } from '../../templates/types';
interface LineElementProps {
    element: LineElementType;
    selected?: boolean;
    editorMode?: boolean;
    colorOverride?: string;
    filter?: string;
    onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onClick?: () => void;
}
export declare function LineElement({ element, selected, editorMode, colorOverride, filter, onPointerDown, onClick, }: LineElementProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=LineElement.d.ts.map