import { TextElement } from '../../templates/types';
export interface VerticalTextLayout {
    text: string;
    width: number;
    xOffset: number;
    writingMode: 'vertical-rl' | 'vertical-lr';
}
export interface HorizontalTextLayout {
    height: number;
}
export declare function getHorizontalTextLayout(element: TextElement): HorizontalTextLayout;
export declare function getVerticalTextLayout(text: string, element: TextElement, lineHeight: number): VerticalTextLayout;
//# sourceMappingURL=verticalText.d.ts.map