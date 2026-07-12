import type { LegacySection } from "@qingagent/contract-ts";

export function deriveTitleFromSections(sections: readonly LegacySection[]): string | null {
  const h1 = sections.find((section) => section.kind === "h1");
  if (!h1 || !("text" in h1.data)) return null;
  const title = h1.data.text.trim();
  return title || null;
}
