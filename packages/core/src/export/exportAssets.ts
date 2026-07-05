import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import katex from "katex";
import hljs from "highlight.js";

// 导出用的"重资产"渲染:数学公式(KaTeX)与代码语法高亮(highlight.js),与前端口径一致。
// KaTeX 的 CSS + 字体在文档含公式时内嵌进导出 HTML(base64 自包含,PDF 离线渲染 / HTML 任意打开均可)。

const require = createRequire(import.meta.url);

/** 渲染一段 LaTeX 为 KaTeX HTML;失败回退为转义源码(由调用方包裹)。displayMode=块级居中。 */
export function renderMathHtml(latex: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: "html",
      strict: "ignore",
    });
  } catch {
    return null;
  }
}

/** 用 highlight.js 给代码加 hljs span(已转义);仅在语言已知时高亮,否则返回 null 让调用方走纯文本。 */
export function highlightCodeHtml(code: string, language: string | null | undefined): string | null {
  if (!language) return null;
  const lang = language.toLowerCase();
  try {
    if (!hljs.getLanguage(lang)) return null;
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

let cachedKatexCss: string | null = null;
/** katex.min.css + 内嵌 base64 字体,自包含(无外链)。仅在文档含公式时注入。 */
export function katexCssEmbedded(): string {
  if (cachedKatexCss !== null) return cachedKatexCss;
  try {
    const cssPath = require.resolve("katex/dist/katex.min.css");
    const fontsDir = join(dirname(cssPath), "fonts");
    const css = readFileSync(cssPath, "utf8").replace(
      /url\(fonts\/([\w-]+)\.(woff2|woff|ttf)\)/g,
      (match, name: string, ext: string) => {
        try {
          const buf = readFileSync(join(fontsDir, `${name}.${ext}`));
          const mime = ext === "woff2" ? "font/woff2" : ext === "woff" ? "font/woff" : "font/ttf";
          return `url(data:${mime};base64,${buf.toString("base64")})`;
        } catch {
          return match;
        }
      },
    );
    cachedKatexCss = css;
  } catch {
    cachedKatexCss = "";
  }
  return cachedKatexCss;
}
