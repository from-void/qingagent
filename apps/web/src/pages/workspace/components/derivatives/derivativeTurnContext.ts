import type { DerivativeItem } from "./types";
import { getDtypeDescriptor } from "./dtypeRegistry";

export function buildActiveDerivativeTurnContext(
  activeTab: "main" | string,
  derivatives: readonly DerivativeItem[],
): string | null {
  const activeDerivative = derivatives.find((item) => item.docId === activeTab);
  if (!activeDerivative) return null;
  const typeLabel = getDtypeDescriptor(activeDerivative.dtype).label;
  return (
    `[系统:用户当前正查看衍生稿(doc_id: ${activeDerivative.docId},类型=${typeLabel})。` +
    `若本轮是对这篇衍生稿的修改诉求,按「已有衍生稿修改路由」执行,doc_id 已给出无需 list_derivatives 定位。]`
  );
}
