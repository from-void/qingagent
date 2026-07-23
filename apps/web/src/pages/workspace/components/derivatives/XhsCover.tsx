import { useEffect } from "react";
import { XHS_COVER_FONT_FACES, xhsCoverFontFaceCss } from "./xhsCoverFonts";

export const XHS_COVER_TEMPLATES = ["poster", "magazine", "wenkai", "impact", "note"] as const;
export type XhsCoverTemplate = typeof XHS_COVER_TEMPLATES[number];

const TEMPLATE_NAMES: Record<XhsCoverTemplate, string> = {
  poster: "大字报",
  magazine: "杂志衬线",
  wenkai: "文楷手记",
  impact: "黑白冲击",
  note: "便签清单",
};

const fontLoads = new Map<XhsCoverTemplate, Promise<void>>();

/** 只在对应封面首次出现时注册并请求字体，避免其余模板承担字体下载成本。 */
export function ensureCoverTemplateFont(template: XhsCoverTemplate): Promise<void> {
  const font = XHS_COVER_FONT_FACES[template as keyof typeof XHS_COVER_FONT_FACES];
  if (!font || typeof document === "undefined") return Promise.resolve();
  const cached = fontLoads.get(template);
  if (cached && document.head.querySelector(`[data-xhs-cover-font="${template}"]`)) return cached;
  const style = document.createElement("style");
  style.dataset.xhsCoverFont = template;
  style.textContent = xhsCoverFontFaceCss(font);
  document.head.append(style);
  const fonts = document.fonts;
  const loading = fonts?.load ? fonts.load(`1em "${font.family}"`).then(() => undefined).catch(() => undefined) : Promise.resolve();
  fontLoads.set(template, loading);
  return loading;
}

function splitPosterHighlight(title: string): { before: string; highlight: string; after: string } {
  const emojiIndex = title.search(/\p{Extended_Pictographic}/u);
  const end = emojiIndex >= 0 ? emojiIndex : title.length;
  const prefix = title.slice(0, end);
  const word = prefix.match(/([\p{L}\p{N}]{2,4})[\s，。！？、：:；;]*$/u);
  const highlight = word?.[1] ?? Array.from(prefix).slice(-Math.min(4, Math.max(2, Array.from(prefix).length))).join("");
  const start = Math.max(0, prefix.lastIndexOf(highlight));
  return { before: title.slice(0, start), highlight, after: title.slice(start + highlight.length) };
}

function ArrowIcon({ direction }: { direction: "left" | "right" }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={direction === "left" ? "m15 5-7 7 7 7" : "m9 5 7 7-7 7"}/></svg>;
}

export function XhsCover(props: { title: string; template: XhsCoverTemplate; onTemplateChange: (template: XhsCoverTemplate) => void }) {
  useEffect(() => { void ensureCoverTemplateFont(props.template); }, [props.template]);
  const index = XHS_COVER_TEMPLATES.indexOf(props.template);
  const long = Array.from(props.title).length > 12;
  const poster = splitPosterHighlight(props.title);
  const selectOffset = (offset: number) => props.onTemplateChange(XHS_COVER_TEMPLATES[(index + offset + XHS_COVER_TEMPLATES.length) % XHS_COVER_TEMPLATES.length]!);

  return <div className={`xhs-cover xhs-cover--${props.template}${long ? " is-long" : ""}`} data-cover-template={props.template} data-title-size={long ? "compact" : "default"}>
    {props.template === "poster" ? <><span className="xhs-cover-kicker">青简笔记</span><strong><span>{poster.before}</span><mark>{poster.highlight}</mark><span>{poster.after}</span></strong></> : null}
    {props.template === "magazine" ? <><span className="xhs-cover-eyebrow">NOTES</span><strong>{props.title}</strong><i className="xhs-cover-rule"/><span className="xhs-cover-footer">·青简·</span></> : null}
    {props.template === "wenkai" ? <><i className="xhs-cover-boundary"/><strong>{props.title}</strong><span className="xhs-cover-seal">记</span></> : null}
    {props.template === "impact" ? <><span className="xhs-cover-number">01</span><strong>{props.title}<i aria-hidden="true"/></strong></> : null}
    {props.template === "note" ? <div className="xhs-cover-note"><i className="xhs-cover-tape"/><strong>{props.title}</strong><span className="xhs-cover-lines" aria-hidden="true"><i/><i/><i/></span></div> : null}
    <div className="xhs-cover-controls">
      <button type="button" className="xhs-cover-arrow is-prev" aria-label="上一款封面" onClick={() => selectOffset(-1)}><ArrowIcon direction="left"/></button>
      <button type="button" className="xhs-cover-arrow is-next" aria-label="下一款封面" onClick={() => selectOffset(1)}><ArrowIcon direction="right"/></button>
      <div className="xhs-cover-dots" role="group" aria-label="封面模板">
        {XHS_COVER_TEMPLATES.map((template) => <button key={template} type="button" className={template === props.template ? "is-active" : ""} aria-label={`选择${TEMPLATE_NAMES[template]}封面`} aria-pressed={template === props.template} onClick={() => props.onTemplateChange(template)}/>)}
      </div>
    </div>
  </div>;
}
