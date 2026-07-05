import type { TemplateDefinition } from '../types';
import { curatedTemplates } from './curated-templates';

export const defaultTemplates: TemplateDefinition[] = curatedTemplates;

// 语义别名：[0]山水留白 作水墨、[1]桃花疏影 作极简、[2]翠鸟荷笺(preferVerticalText) 作竖排
export const inkWashTemplate = defaultTemplates[0];
export const minimalTemplate = defaultTemplates[1];
export const verticalTextTemplate = defaultTemplates[2];
