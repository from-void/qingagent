import { MasonryColorConfig, TemplateDefinition } from '../templates/types';
export interface MasonryMetrics {
    columns: number;
    gridWidth: number;
    sidePadding: number;
}
export declare function calculateMasonryMetrics(containerWidth: number, columnGutter?: number, minColumns?: number): MasonryMetrics;
export declare function isPureChineseText(value: string): boolean;
export declare function normalizeColorConfig(config?: Partial<MasonryColorConfig>): Required<MasonryColorConfig>;
export declare function cloneTemplate(template: TemplateDefinition): TemplateDefinition;
export declare function clamp(value: number, min: number, max: number): number;
export declare function snapToGrid(value: number, grid?: number): number;
//# sourceMappingURL=index.d.ts.map