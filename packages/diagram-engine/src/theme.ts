import { CLASS_ASSIGNMENT_RE, CLASS_DEFINITION_RE, INLINE_STYLE_RE, getLines, stripTrailingComment } from "./shared.js";

import { GRAPH_LAYOUT_NODE_MAX_HEIGHT, GRAPH_LAYOUT_NODE_MAX_WIDTH, GRAPH_LAYOUT_NODE_MIN_HEIGHT, GRAPH_LAYOUT_NODE_MIN_WIDTH, clampNodeHeight, clampNodeWidth, sanitizeColor, sanitizeCurve, sanitizeDashArray } from "./presentation.js";

import { BaseEdge, DiagramThemeMetadata, EdgeStyleOverride, NodeStyleOverride, ThemePalette } from "./types.js";



export function parseDiagramThemeMetadata(
  source: string,
  nodeIds: Iterable<string>,
  inlineNodeClasses: Map<string, string[]> = new Map(),
  edges: BaseEdge[] = [],
  subgraphIds: Iterable<string> = [],
): DiagramThemeMetadata {
  const themePalette = parseThemePalette(source);
  const { classDefinitions, nodeClasses, nodeStyles } = parseClassStyleStatements(source);
  for (const [nodeId, classNames] of inlineNodeClasses) {
    appendNodeClasses(nodeClasses, nodeId, classNames);
  }

  const perNodeStyles: Record<string, NodeStyleOverride> = {};
  for (const nodeId of nodeIds) {
    const assignedClassNames = nodeClasses.get(nodeId) ?? [];
    const classNames = classDefinitions.has("default") ? ["default", ...assignedClassNames] : assignedClassNames;
    const classStyle = classNames.reduce<NodeStyleOverride>((merged, className) => {
      const classStyle = classDefinitions.get(className);
      return classStyle ? { ...merged, ...classStyle } : merged;
    }, {});
    const style = { ...classStyle, ...(nodeStyles.get(nodeId) ?? {}) };
    if (Object.keys(style).length > 0) perNodeStyles[nodeId] = style;
  }
  const perEdgeStyles = parseLinkStyleStatements(source, edges);
  const perSubgraphStyles: Record<string, NodeStyleOverride> = {};
  for (const subgraphId of subgraphIds) {
    const assignedClassNames = nodeClasses.get(subgraphId) ?? [];
    const classNames = classDefinitions.has("default") ? ["default", ...assignedClassNames] : assignedClassNames;
    const classStyle = classNames.reduce<NodeStyleOverride>((merged, className) => {
      const classStyle = classDefinitions.get(className);
      return classStyle ? { ...merged, ...classStyle } : merged;
    }, {});
    const style = { ...classStyle, ...(nodeStyles.get(subgraphId) ?? {}) };
    if (Object.keys(style).length > 0) perSubgraphStyles[subgraphId] = style;
  }

  return {
    ...(themePalette ? { themePalette } : {}),
    ...(Object.keys(perNodeStyles).length > 0 ? { perNodeStyles } : {}),
    ...(Object.keys(perSubgraphStyles).length > 0 ? { perSubgraphStyles } : {}),
    ...(Object.keys(perEdgeStyles).length > 0 ? { perEdgeStyles } : {}),
  };
}

export const REPRESENTED_THEME_VARIABLES = new Set([
  "background",
  "clusterBkg",
  "clusterBorder",
  "edgeLabelBackground",
  "fontSize",
  "lineColor",
  "mainBkg",
  "nodeBorder",
  "primaryBorderColor",
  "primaryColor",
  "primaryTextColor",
  "textColor",
]);

export function objectKeysAtTopLevel(source: string): string[] {
  const keys: string[] = [];
  let index = 0;
  while (index < source.length) {
    while (/[\s,]/.test(source[index] ?? "")) index += 1;
    if (index >= source.length) break;
    let key = "";
    const quote = source[index];
    if (quote === "'" || quote === '"') {
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") index += 1;
        key += source[index] ?? "";
        index += 1;
      }
      index += 1;
    } else {
      const match = source.slice(index).match(/^[\w-]+/);
      if (!match) return [];
      key = match[0];
      index += key.length;
    }
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== ":") return [];
    keys.push(key);
    index += 1;

    let braces = 0;
    let brackets = 0;
    let valueQuote: "'" | '"' | null = null;
    let escaped = false;
    while (index < source.length) {
      const char = source[index]!;
      if (valueQuote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === valueQuote) {
          valueQuote = null;
        }
      } else if (char === "'" || char === '"') {
        valueQuote = char;
      } else if (char === "{") {
        braces += 1;
      } else if (char === "}") {
        braces -= 1;
      } else if (char === "[") {
        brackets += 1;
      } else if (char === "]") {
        brackets -= 1;
      } else if (char === "," && braces === 0 && brackets === 0) {
        index += 1;
        break;
      }
      index += 1;
    }
  }
  return keys;
}

export type RepresentedStyleTarget = "node" | "edge" | "subgraph";

export function exactPixelValueInRange(
  source: string,
  min: number,
  max: number,
  integer = false,
): boolean {
  const match = source.trim().match(/^(\d+(?:\.\d+)?|\.\d+)(?:px)?$/i);
  if (!match) return false;
  const value = Number(match[1]);
  return (
    Number.isFinite(value)
    && value >= min
    && value <= max
    && (!integer || Number.isInteger(value))
  );
}

export function styleValueFullyRepresented(
  property: string,
  rawValue: string,
  target: RepresentedStyleTarget,
): boolean {
  const value = rawValue.trim().replace(/;$/, "");
  if (property === "color" || property === "stroke") {
    return sanitizeColor(value) !== null;
  }
  if (property === "stroke-dasharray") {
    return target !== "subgraph" && sanitizeDashArray(value) !== null;
  }
  if (property === "stroke-width") {
    return exactPixelValueInRange(value, 1, 8);
  }
  if (target === "edge") {
    // renderer 只分别实现直线和居中阶梯线；其余 Mermaid 曲线会被统一成
    // 同一条通用 Bézier，无法保真表达原始 curve 取值。
    return property === "curve" && (value === "linear" || value === "step");
  }
  if (property === "fill") return sanitizeColor(value) !== null;
  // 分区画布只承载容器填充、描边、标题色与描边规格。节点几何/字号属性
  // 不能套到 subgraph 上，否则原生 Mermaid 与可视化画布会出现静默差异。
  if (target === "subgraph") return false;
  if (property === "font-size") return exactPixelValueInRange(value, 9, 28);
  if (property === "rx" || property === "ry") {
    return exactPixelValueInRange(value, 0, 80);
  }
  if (property === "width") {
    return exactPixelValueInRange(
      value,
      GRAPH_LAYOUT_NODE_MIN_WIDTH,
      GRAPH_LAYOUT_NODE_MAX_WIDTH,
      true,
    );
  }
  if (property === "height") {
    return exactPixelValueInRange(
      value,
      GRAPH_LAYOUT_NODE_MIN_HEIGHT,
      GRAPH_LAYOUT_NODE_MAX_HEIGHT,
      true,
    );
  }
  return false;
}

export function stylePropertiesFullyRepresented(
  source: string,
  target: RepresentedStyleTarget,
): boolean {
  const declarations = splitStyleDeclarations(source);
  if (declarations.length === 0) return false;
  return declarations.every((declaration) => {
    const colon = declaration.indexOf(":");
    if (colon < 0) return false;
    return styleValueFullyRepresented(
      declaration.slice(0, colon).trim().toLowerCase(),
      declaration.slice(colon + 1),
      target,
    );
  });
}

export function initDirectiveFullyRepresented(source: string): boolean {
  return initDirectiveUnavailableReason(source) === null;
}

export function initDirectiveUnavailableReason(source: string): string | null {
  const initMatches = [...source.matchAll(/%%\{\s*init\s*:/gi)];
  if (initMatches.length === 0) return null;
  if (initMatches.length !== 1) {
    return "当前 Mermaid 源码包含多条 init 指令，可视化编辑器无法确定唯一主题配置；已保留 Mermaid 预览";
  }
  const initStart = initMatches[0]!;
  const payloadStart = initStart.index + initStart[0].length;
  const directiveEnd = /\}\s*%%/g;
  directiveEnd.lastIndex = payloadStart;
  const endMatch = directiveEnd.exec(source);
  if (!endMatch) return "当前 Mermaid init 指令不完整，暂时无法使用可视化编辑；已保留 Mermaid 预览";
  const payload = source.slice(payloadStart, endMatch.index);
  const objectStart = payload.indexOf("{");
  if (objectStart < 0) return "当前 Mermaid init 指令无法解析，暂时无法使用可视化编辑；已保留 Mermaid 预览";
  const initBody = extractBalancedObjectBody(payload, objectStart);
  if (initBody === null) return "当前 Mermaid init 指令无法解析，暂时无法使用可视化编辑；已保留 Mermaid 预览";
  const initKeys = objectKeysAtTopLevel(initBody);
  if (
    initKeys.length === 0 ||
    initKeys.some((key) => key !== "theme" && key !== "themeVariables")
  ) {
    return "当前 Mermaid init 含可视化编辑器尚未完整支持的配置；已保留 Mermaid 预览，可继续编辑源码";
  }
  const theme = readObjectValue(initBody, "theme");
  if (theme !== undefined && theme.toLowerCase() !== "base") {
    return `当前 Mermaid 主题 ${theme} 暂不支持可视化编辑，已保留 Mermaid 预览；改用 base 主题后可恢复`;
  }

  const themeVariablesKey =
    /(?:["']themeVariables["']|\bthemeVariables\b)\s*:/i.exec(initBody);
  if (!themeVariablesKey) {
    return "当前 Mermaid init 缺少 themeVariables，可视化编辑器无法保真还原主题；已保留 Mermaid 预览";
  }
  const variablesStart = initBody.indexOf(
    "{",
    themeVariablesKey.index + themeVariablesKey[0].length,
  );
  if (variablesStart < 0) return "当前 Mermaid themeVariables 无法解析；已保留 Mermaid 预览";
  const variablesBody = extractBalancedObjectBody(initBody, variablesStart);
  if (variablesBody === null) return "当前 Mermaid themeVariables 无法解析；已保留 Mermaid 预览";
  const variableKeys = objectKeysAtTopLevel(variablesBody);
  if (
    variableKeys.length === 0 ||
    variableKeys.some((key) => !REPRESENTED_THEME_VARIABLES.has(key)) ||
    variableKeys.some((key) => {
      const value = readObjectValue(variablesBody, key);
      return key === "fontSize"
        ? !value || !exactPixelValueInRange(value, 9, 28)
        : !sanitizeColor(value);
    })
  ) {
    return "当前 Mermaid 主题变量含可视化编辑器尚未完整支持的配置；已保留 Mermaid 预览，可继续编辑源码";
  }

  const palette = parseThemePalette(source);
  const missing = [
    ...(!palette?.nodeFill ? ["mainBkg/primaryColor"] : []),
    ...(!palette?.nodeStroke ? ["nodeBorder/primaryBorderColor"] : []),
    ...(!palette?.lineColor ? ["lineColor"] : []),
    ...(!palette?.textColor ? ["textColor/primaryTextColor"] : []),
    ...(/^\s*subgraph\b/im.test(source) && !palette?.clusterFill ? ["clusterBkg"] : []),
    ...(/^\s*subgraph\b/im.test(source) && !palette?.clusterStroke ? ["clusterBorder"] : []),
  ];
  return missing.length > 0
    ? `当前 Mermaid 主题缺少 ${missing.join("、")}，可视化编辑器无法保真还原配色；已保留 Mermaid 预览`
    : null;
}

export function presentationSyntaxFullyRepresented(source: string): boolean {
  return presentationSyntaxUnavailableReason(source) === null;
}

export function presentationSyntaxUnavailableReason(source: string): string | null {
  const initReason = initDirectiveUnavailableReason(source);
  if (initReason) return initReason;
  const subgraphIds = new Set<string>();
  const subgraphClassNames = new Set<string>();
  for (const line of getLines(source)) {
    const trimmed = stripTrailingComment(line.text).trim();
    const subgraph = trimmed.match(/^subgraph\s+([A-Za-z_][\w-]*)(?=\s|\[|\(|\{|$)/i);
    if (subgraph) subgraphIds.add(subgraph[1]!);
  }
  for (const line of getLines(source)) {
    const assignment = stripTrailingComment(line.text).trim().match(CLASS_ASSIGNMENT_RE);
    if (!assignment) continue;
    if (assignment[1]!.split(",").some((id) => subgraphIds.has(id.trim()))) {
      subgraphClassNames.add(assignment[2]!);
    }
  }
  for (const line of getLines(source)) {
    const trimmed = stripTrailingComment(line.text).trim();
    const classDefinition = trimmed.match(CLASS_DEFINITION_RE);
    const classTargetsSubgraph = classDefinition?.[1]!.split(",").some((className) =>
      className.trim() === "default" ? subgraphIds.size > 0 : subgraphClassNames.has(className.trim())
    ) ?? false;
    if (
      classDefinition &&
      !stylePropertiesFullyRepresented(
        classDefinition[2]!,
        classTargetsSubgraph ? "subgraph" : "node",
      )
    ) {
      return classTargetsSubgraph
        ? "当前 Mermaid 分区 classDef 含可视化编辑器尚未支持的样式；已保留 Mermaid 预览"
        : "当前 Mermaid classDef 含可视化编辑器尚未支持的样式；已保留 Mermaid 预览，可继续编辑源码";
    }
    const inlineStyle = trimmed.match(INLINE_STYLE_RE);
    if (
      inlineStyle &&
      !stylePropertiesFullyRepresented(
        inlineStyle[2]!,
        subgraphIds.has(inlineStyle[1]!) ? "subgraph" : "node",
      )
    ) {
      return subgraphIds.has(inlineStyle[1]!)
        ? `分区 ${inlineStyle[1]} 的 style 含可视化编辑器尚未支持的属性；已保留 Mermaid 预览`
        : "当前 Mermaid 节点 style 含可视化编辑器尚未支持的属性；已保留 Mermaid 预览";
    }
    const linkStyle = trimmed.match(/^linkStyle\s+\S+\s+(.+?)\s*;?$/i);
    if (
      linkStyle &&
      !stylePropertiesFullyRepresented(
        linkStyle[1]!,
        "edge",
      )
    ) {
      return "当前 Mermaid 连线样式含可视化编辑器尚未支持的属性；已保留 Mermaid 预览";
    }
  }
  return null;
}

export function parseThemePalette(source: string): ThemePalette | undefined {
  const initStart = /%%\{\s*init\s*:/i.exec(source);
  if (!initStart) return undefined;
  const payloadStart = initStart.index + initStart[0].length;
  const directiveEnd = /\}\s*%%/g;
  directiveEnd.lastIndex = payloadStart;
  const endMatch = directiveEnd.exec(source);
  if (!endMatch) return undefined;
  const payload = source.slice(payloadStart, endMatch.index);
  const themeVariablesKey = /(?:["']themeVariables["']|\bthemeVariables\b)\s*:/i.exec(payload);
  if (!themeVariablesKey) return undefined;
  const objectStart = payload.indexOf("{", themeVariablesKey.index + themeVariablesKey[0].length);
  if (objectStart < 0) return undefined;
  const themeVariables = extractBalancedObjectBody(payload, objectStart);
  if (themeVariables === null) return undefined;

  const readColor = (key: string) => sanitizeColor(readObjectValue(themeVariables, key));
  const rawFontSize = readObjectValue(themeVariables, "fontSize");
  const fontSize = rawFontSize && exactPixelValueInRange(rawFontSize, 9, 28)
    ? Number.parseFloat(rawFontSize)
    : undefined;
  const palette: ThemePalette = {
    canvasBackground: readColor("background") ?? undefined,
    nodeFill: readColor("mainBkg") ?? readColor("primaryColor") ?? undefined,
    nodeStroke: readColor("nodeBorder") ?? readColor("primaryBorderColor") ?? undefined,
    lineColor: readColor("lineColor") ?? undefined,
    edgeLabelBackground: readColor("edgeLabelBackground") ?? undefined,
    textColor: readColor("textColor") ?? readColor("primaryTextColor") ?? undefined,
    clusterFill: readColor("clusterBkg") ?? undefined,
    clusterStroke: readColor("clusterBorder") ?? undefined,
    fontSize,
  };
  return Object.values(palette).some(Boolean) ? palette : undefined;
}

export function extractBalancedObjectBody(source: string, objectStart: number): string | null {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(objectStart + 1, index);
  }
  return null;
}

export function readObjectValue(source: string, key: string): string | undefined {
  const keyPattern = new RegExp(`(?:["']${key}["']|\\b${key}\\b)\\s*:`, "i");
  const match = keyPattern.exec(source);
  if (!match) return undefined;
  const valueSource = source.slice(match.index + match[0].length).trimStart();
  const quote = valueSource[0];
  if (quote === "'" || quote === '"') {
    let escaped = false;
    for (let index = 1; index < valueSource.length; index += 1) {
      const char = valueSource[index]!;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        return valueSource.slice(1, index);
      }
    }
    return undefined;
  }
  return valueSource.split(/[,}]/, 1)[0]?.trim();
}

export function parseClassStyleStatements(source: string): {
  classDefinitions: Map<string, NodeStyleOverride>;
  nodeClasses: Map<string, string[]>;
  nodeStyles: Map<string, NodeStyleOverride>;
} {
  const classDefinitions = new Map<string, NodeStyleOverride>();
  const nodeClasses = new Map<string, string[]>();
  const nodeStyles = new Map<string, NodeStyleOverride>();
  for (const line of getLines(source)) {
    const trimmed = stripTrailingComment(line.text).trim();
    const definition = trimmed.match(CLASS_DEFINITION_RE);
    if (definition) {
      const style = parseClassDefinitionStyle(definition[2]!);
      if (style) {
        for (const className of definition[1]!.split(",").map((value) => value.trim()).filter(Boolean)) {
          classDefinitions.set(className, style);
        }
      }
      continue;
    }
    const assignment = trimmed.match(CLASS_ASSIGNMENT_RE);
    if (assignment) {
      const className = assignment[2]!;
      for (const nodeId of assignment[1]!.split(",").map((value) => value.trim()).filter(Boolean)) {
        appendNodeClasses(nodeClasses, nodeId, [className]);
      }
      continue;
    }
    const inlineStyle = trimmed.match(INLINE_STYLE_RE);
    if (inlineStyle) {
      const style = parseClassDefinitionStyle(inlineStyle[2]!);
      if (style) nodeStyles.set(inlineStyle[1]!, { ...(nodeStyles.get(inlineStyle[1]!) ?? {}), ...style });
    }
  }
  return { classDefinitions, nodeClasses, nodeStyles };
}

export function parseClassDefinitionStyle(source: string): NodeStyleOverride | undefined {
  const style: NodeStyleOverride = {};
  for (const declaration of splitStyleDeclarations(source)) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const rawValue = declaration.slice(colon + 1).trim().replace(/;$/, "");
    if (property === "fill") {
      const fill = sanitizeColor(rawValue);
      if (fill) style.fill = fill;
    } else if (property === "stroke") {
      const stroke = sanitizeColor(rawValue);
      if (stroke) style.stroke = stroke;
    } else if (property === "color") {
      const textColor = sanitizeColor(rawValue);
      if (textColor) style.textColor = textColor;
    } else if (property === "stroke-width") {
      const width = Number.parseFloat(rawValue);
      if (Number.isFinite(width) && width > 0) style.strokeWidth = Math.max(1, Math.min(8, width));
    } else if (property === "font-size") {
      const size = Number.parseFloat(rawValue);
      if (Number.isFinite(size) && size > 0) style.fontSize = Math.max(9, Math.min(48, size));
    } else if (property === "rx" || property === "ry") {
      const radius = Number.parseFloat(rawValue);
      if (Number.isFinite(radius) && radius >= 0) {
        style[property] = Math.max(0, Math.min(80, radius));
      }
    } else if (property === "width") {
      const width = Number.parseFloat(rawValue);
      if (Number.isFinite(width) && width > 0) style.width = clampNodeWidth(width);
    } else if (property === "height") {
      const height = Number.parseFloat(rawValue);
      if (Number.isFinite(height) && height > 0) style.height = clampNodeHeight(height);
    } else if (property === "stroke-dasharray") {
      const dashArray = sanitizeDashArray(rawValue);
      if (dashArray) style.dashArray = dashArray;
    }
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

export function parseEdgeStyle(source: string): EdgeStyleOverride | undefined {
  const style: EdgeStyleOverride = {};
  for (const declaration of splitStyleDeclarations(source)) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const rawValue = declaration.slice(colon + 1).trim().replace(/;$/, "");
    if (property === "stroke") {
      const stroke = sanitizeColor(rawValue);
      if (stroke) style.stroke = stroke;
    } else if (property === "color") {
      const textColor = sanitizeColor(rawValue);
      if (textColor) style.textColor = textColor;
    } else if (property === "stroke-width") {
      const width = Number.parseFloat(rawValue);
      if (Number.isFinite(width) && width > 0) style.strokeWidth = Math.max(1, Math.min(8, width));
    } else if (property === "stroke-dasharray") {
      const dashArray = sanitizeDashArray(rawValue);
      if (dashArray) style.dashArray = dashArray;
    } else if (property === "curve") {
      const curve = sanitizeCurve(rawValue);
      if (curve) style.curve = curve;
    }
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

export function parseLinkStyleStatements(source: string, edges: BaseEdge[]): Record<string, EdgeStyleOverride> {
  const out: Record<string, EdgeStyleOverride> = {};
  for (const line of getLines(source)) {
    const match = stripTrailingComment(line.text).trim().match(/^linkStyle\s+(\S+)\s+(.+?)\s*;?$/i);
    if (!match) continue;
    const style = parseEdgeStyle(match[2]!);
    if (!style) continue;
    const indexes = match[1]!.toLowerCase() === "default"
      ? edges.map((edge) => edge.orderIndex)
      : match[1]!.split(",").map((value) => Number.parseInt(value.trim(), 10)).filter(Number.isFinite);
    for (const index of indexes) {
      const edge = edges.find((item) => item.orderIndex === index);
      if (edge) out[edge.id] = { ...(out[edge.id] ?? {}), ...style };
    }
  }
  return out;
}

export function splitStyleDeclarations(source: string): string[] {
  const declarations: string[] = [];
  let start = 0;
  let parentheses = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "(") {
      parentheses += 1;
    } else if (char === ")") {
      parentheses = Math.max(0, parentheses - 1);
    } else if (char === "," && parentheses === 0) {
      declarations.push(source.slice(start, index));
      start = index + 1;
    }
  }
  declarations.push(source.slice(start));
  return declarations;
}

export function appendNodeClasses(target: Map<string, string[]>, nodeId: string, classNames: string[]): void {
  if (classNames.length === 0) return;
  const current = target.get(nodeId) ?? [];
  target.set(nodeId, [...current, ...classNames]);
}
