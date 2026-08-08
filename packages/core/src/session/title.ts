import { pmToPlainText, type PmDoc } from "@qingagent/pm-schema";

export function deriveTitleFromDoc(doc: PmDoc | undefined): string | null {
  const h1 = doc?.content.find(
    (block) => block.type === "heading" && block.attrs.level === 1,
  );
  if (!h1 || !doc) return null;
  const title = pmToPlainText({ ...doc, content: [h1] }).trim();
  return title || null;
}
