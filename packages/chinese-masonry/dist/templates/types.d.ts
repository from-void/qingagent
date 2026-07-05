import { CSSProperties } from 'react';
import { CARD_WIDTH } from '../constants';
export interface ArticleData {
    id: string;
    title: string;
    description?: string;
    imageUrl?: string;
    category?: string;
    tags?: string[];
    author?: string;
    date?: string;
    metadata?: Record<string, any>;
}
export type TemplateElement = TextElement | ImageElement | LineElement;
export interface BaseElement {
    id: string;
    x: number;
    y: number;
}
export interface TextElement extends BaseElement {
    type: 'text';
    role: 'title' | 'description' | 'decoration';
    content?: string;
    width: number;
    height: number;
    fontSize: number;
    color: string;
    direction: 'horizontal' | 'vertical';
    fontWeight?: 'normal' | 'bold';
    letterSpacing?: number;
    lineHeight?: number;
    maxLines: number;
    textAlign?: 'left' | 'center' | 'right';
    blockAlign?: 'start' | 'end';
}
export interface ImageElement extends BaseElement {
    type: 'image';
    role?: 'background' | 'stamp';
    source: 'static' | 'dynamic';
    staticUrl?: string;
    prompt?: string;
    width: number;
    height: number;
    objectFit?: 'cover' | 'contain';
    objectPosition?: string;
    opacity?: number;
    shape: 'rectangle' | 'trapezoid';
    clipPath?: string;
    zIndex?: number;
}
export interface LineElement extends BaseElement {
    type: 'line';
    length: number;
    direction: 'horizontal' | 'vertical';
    thickness: number;
    color: string;
    zIndex?: number;
}
export interface GlobalFontConfig {
    titleFont: string;
    descriptionFont: string;
    titleEnglishFont?: string;
    titleChineseFont?: string;
    descriptionEnglishFont?: string;
    descriptionChineseFont?: string;
}
export interface MasonryColorConfig {
    enabled: boolean;
    grayscale?: number;
    sepia?: number;
    overlayColor?: string;
    overlayOpacity?: number;
    textColor?: string;
    lineColor?: string;
    transitionDuration?: number;
}
export interface TextCapacityInfo {
    direction: 'horizontal' | 'vertical';
    maxCharacters: number;
    charactersPerLine?: number;
    charactersPerColumn?: number;
    lineCount?: number;
    columnCount?: number;
    fontSize: number;
    letterSpacing: number;
    lineHeight: number;
}
export interface TemplateTextCapacity {
    title?: TextCapacityInfo;
    description?: TextCapacityInfo;
}
export interface TemplateMeta {
    category: string;
    tags: string[];
    requiresImage: boolean;
    preferVerticalText: boolean;
    minTitleLength?: number;
    maxTitleLength?: number;
    textCapacity?: TemplateTextCapacity;
    weight: number;
    thumbnail?: string;
}
export interface TemplateDefinition {
    id: string;
    name: string;
    version: number;
    width: typeof CARD_WIDTH;
    height: number;
    backgroundColor?: string;
    borderRadius?: string;
    elements: TemplateElement[];
    meta: TemplateMeta;
}
export interface SelectorOptions {
    random?: () => number;
    excludeTemplateIds?: string[];
    allowFallback?: boolean;
    /** Optional filter to hard-exclude templates for a given article. Return `false` to exclude. */
    templateFilter?: (article: ArticleData, template: TemplateDefinition) => boolean;
}
export interface SelectCallOptions {
    excludeTemplateIds?: string[];
}
export interface CardRendererProps {
    article: ArticleData;
    template: TemplateDefinition;
    fontConfig?: Partial<GlobalFontConfig>;
    colorConfig?: MasonryColorConfig;
    className?: string;
    style?: CSSProperties;
    onClick?: (article: ArticleData) => void;
}
//# sourceMappingURL=types.d.ts.map