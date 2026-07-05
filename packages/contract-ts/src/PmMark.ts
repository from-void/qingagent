export type PmThemeColor =
  | "ink"
  | "gray"
  | "slate"
  | "brown"
  | "red"
  | "orange"
  | "amber"
  | "yellow"
  | "lime"
  | "green"
  | "sage"
  | "mint"
  | "teal"
  | "cyan"
  | "sky"
  | "blue"
  | "indigo"
  | "violet"
  | "purple"
  | "magenta"
  | "pink"
  | "rose"
  | "sand"
  | "lavender";

export type PmMark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "underline" }
  | { type: "strike" }
  | { type: "code" }
  | { type: "link"; attrs: { href: string; title?: string | null } }
  | { type: "textColor"; attrs: { color: PmThemeColor } }
  | { type: "highlight"; attrs: { color: PmThemeColor } };
