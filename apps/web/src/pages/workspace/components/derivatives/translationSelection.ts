import type { DerivativeItem } from "./types";

/**
 * 恢复翻译 Tab 时优先落到已有成品；用户主动选择的仍优先保留。
 */
export function selectTranslationItem(
  items: readonly DerivativeItem[],
  activeDocId?: string | null,
): DerivativeItem | undefined {
  const translations = items.filter((item) => item.dtype === "translate");
  return translations.find((item) => item.docId === activeDocId)
    ?? translations.find((item) => item.generatedAt != null)
    ?? translations[0];
}
