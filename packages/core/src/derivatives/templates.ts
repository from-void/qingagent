// 模板注册表已退役：数据库 style_templates 是运行时唯一真相；此入口仅保留调用名兼容。
export { getStyleTemplate as findDerivTemplate } from "@qingagent/db";
export type { StyleTemplate as DerivTemplate } from "@qingagent/db";
