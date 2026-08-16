import { getSchema } from "@tiptap/core";
import { createQingagentExtensions } from "./createQingagentExtensions";

/** 服务端持久化比较与原生 PM 结构编辑共用的产品 schema 单例。 */
export const qingagentSchema = getSchema(createQingagentExtensions());
