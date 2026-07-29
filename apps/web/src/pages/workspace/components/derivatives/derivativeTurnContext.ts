import type { ActiveDocumentTarget } from "@qingagent/contract-ts";
import type { DerivativeItem } from "./types";
import { getDtypeDescriptor } from "./dtypeRegistry";

function resolveActiveDerivative(
  activeTab: "main" | string,
  derivatives: readonly DerivativeItem[],
  activeTranslationDocId?: string | null,
): DerivativeItem | null {
  return activeTab === "translate"
    ? derivatives.find(
      (item) =>
        item.dtype === "translate" && item.docId === activeTranslationDocId,
    ) ?? derivatives.find((item) => item.dtype === "translate") ?? null
    : derivatives.find((item) => item.docId === activeTab) ?? null;
}

export function buildActiveDerivativeTurnContext(
  activeTab: "main" | string,
  derivatives: readonly DerivativeItem[],
  activeTranslationDocId?: string | null,
): string | null {
  const activeDerivative = resolveActiveDerivative(
    activeTab,
    derivatives,
    activeTranslationDocId,
  );
  if (!activeDerivative) return null;
  const typeLabel = getDtypeDescriptor(activeDerivative.dtype).label;
  return (
    `[系统:用户当前正查看衍生稿(doc_id: ${activeDerivative.docId},类型=${typeLabel})。` +
    `若本轮是对这篇衍生稿的修改诉求,按「已有衍生稿修改路由」执行,doc_id 已给出无需 list_derivatives 定位。]`
  );
}

export interface ActiveDocumentTurnTarget {
  activeDocument: ActiveDocumentTarget;
  label: string;
}

/**
 * 模型路由与输入框目标标识的共同真源。未知/尚未加载的 Tab 安全回退主稿，
 * 绝不能把上一轮衍生稿目标沿用到当前发送。
 */
export function buildActiveDocumentTurnTarget(
  activeTab: "main" | string,
  mainTitle: string,
  derivatives: readonly DerivativeItem[],
  activeTranslationDocId?: string | null,
): ActiveDocumentTurnTarget {
  const activeDerivative = resolveActiveDerivative(
    activeTab,
    derivatives,
    activeTranslationDocId,
  );
  if (!activeDerivative) {
    const normalizedTitle = mainTitle.trim() || "未命名文档";
    return {
      activeDocument: { kind: "main" },
      label: `主稿 · 《${normalizedTitle}》`,
    };
  }

  const descriptor = getDtypeDescriptor(activeDerivative.dtype);
  const detail =
    activeDerivative.dtype === "translate"
      ? activeDerivative.targetLang ?? activeDerivative.templateName
      : activeDerivative.templateName;
  return {
    activeDocument: {
      kind: "derivative",
      docId: activeDerivative.docId,
    },
    label: detail ? `${descriptor.label} · ${detail}` : descriptor.label,
  };
}
