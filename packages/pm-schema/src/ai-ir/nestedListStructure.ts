import type { PmBlockNode, PmDoc } from "../types";

const LIST_WORD_RE = /(列表|清单|条目|list|bullet|ordered|有序|无序)|章\s*[>＞/]\s*条\s*[>＞/]\s*款|章条款/i;
const NESTED_WORD_RE =
  /(嵌套|多级|分级|层级|子列表|子清单|二级列表|二级清单|两级|2\s*级|二层|两层|三级|3\s*级|三层)|章\s*[>＞/]\s*条\s*[>＞/]\s*款|章条款/i;
const THIRD_LEVEL_RE = /(三级|3\s*级|三层|三\s*层)|章\s*[>＞/]\s*条\s*[>＞/]\s*款|章条款/i;
const NEGATION_RE =
  /(?:不要|不用|无需|无须|不需|不必|不想要|不希望|不允许|不得|不可|不能|不(?:采用|使用|做|设|加|放|写|生成|创建|列|嵌套)|别(?:再)?|禁止|避免|勿|拒绝|杜绝)|\b(?:no|not|without|avoid|never)\b|\b(?:do|must)\s+not\b|\b(?:don't|mustn't)\b/i;
const INTENT_CLAUSE_BOUNDARY_RE =
  /[，,。.!！?？;；\n\r]+|(?:但(?:是)?|不过|然而|而(?:是|要)?|却(?:要)?|改(?:为|用|成)|转(?:为|成))/;

function hasAffirmedNestedListClause(text: string): boolean {
  return text
    .split(INTENT_CLAUSE_BOUNDARY_RE)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) =>
      LIST_WORD_RE.test(clause) &&
      NESTED_WORD_RE.test(clause) &&
      !NEGATION_RE.test(clause)
    );
}

export function detectNestedListIntent(text: string): {
  wantsNestedList: boolean;
  minDepth: 2 | 3;
  label: string;
} {
  const normalized = text.trim();
  // 否定按分句生效；列表和层级必须在同一个未否定分句中共同出现。
  // 两类信号缺一、分属不同内容或语义拿不准时均保守返回 false，避免结构验收误报。
  const wantsNestedList = hasAffirmedNestedListClause(normalized);
  const minDepth: 2 | 3 = THIRD_LEVEL_RE.test(normalized) ? 3 : 2;
  return {
    wantsNestedList,
    minDepth,
    label: minDepth >= 3 ? "三级嵌套列表" : "嵌套列表",
  };
}

function calculatePmListDepth(doc: PmDoc): number {
  let maxDepth = 0;

  const visit = (block: PmBlockNode, depth: number): void => {
    // taskList 也是列表层级:多级 taskList 成为一等能力后(57ccd428+扁平depth编译),
    // 用户要"三级待办清单"时 intent 命中 minDepth=3,若这里不计 taskList 层级,
    // 正确用嵌套 taskList 的候选会被 bestStructurallyAware 误判"未达深度"过滤掉,
    // 反而优选用错块型(bulletList)的候选,且全对时还误报 structuralFailures。
    if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") {
      const nextDepth = depth + 1;
      maxDepth = Math.max(maxDepth, nextDepth);
      for (const item of block.content) {
        for (const child of item.content) visit(child, nextDepth);
      }
      return;
    }
    visitChildBlocks(block, (child) => visit(child, depth));
  };

  for (const block of doc.content) visit(block, 0);
  return maxDepth;
}

export function pmDocHasNestedList(doc: PmDoc, minDepth = 2): boolean {
  return calculatePmListDepth(doc) >= minDepth;
}

function visitChildBlocks(block: PmBlockNode, visit: (child: PmBlockNode) => void): void {
  switch (block.type) {
    case "blockquote":
    case "callout":
      block.content.forEach(visit);
      break;
    case "bulletList":
    case "orderedList":
      block.content.forEach((item) => item.content.forEach(visit));
      break;
    case "taskList":
      block.content.forEach((item) => item.content.forEach(visit));
      break;
    case "table":
      block.content.forEach((row) => row.content.forEach((cell) => cell.content.forEach(visit)));
      break;
    case "columnList":
      block.content.forEach((column) => column.content.forEach(visit));
      break;
    default:
      break;
  }
}
