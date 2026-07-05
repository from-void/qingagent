import { type CSSProperties, useMemo } from "react";
import { countDocVisibleChars } from "@qingagent/pm-schema";
import { numberToChinese, formatColophonDate } from "../data/chineseColophon";
import type { ViewDocumentSnapshot } from "../data/protocol";

// 文末落款区块:写完文章后,在正文末尾续一段奶白纸,竖排展示「全文 X 字」「干支年月日」,盖「空生妙有」印章。
// 取代右下角浮动字数徽标。

const SEAL_SRC = "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png";

type ColophonGlyphStyle = CSSProperties & { "--ws-colophon-glyph-x"?: string };

const COLOPHON_GLYPH_OFFSETS: Partial<Record<string, number>> = {
  青: 0.05,
  作: 0.081,
  于: 0.029,
  成: -0.037,
  文: -0.054,
  字: 0.031,
  年: 0.078,
  月: -0.017,
  日: -0.03,
  初: 0.123,
  零: -0.015,
  一: 0.024,
  二: 0.017,
  四: -0.012,
  五: 0.031,
  六: 0.07,
  七: 0.019,
  八: -0.051,
  九: -0.029,
  十: 0.041,
  千: 0.082,
  万: 0.042,
  亿: 0.038,
  丙: 0.018,
  戊: 0.108,
  庚: 0.035,
  辛: 0.025,
  壬: 0.07,
  癸: 0.03,
  子: -0.043,
  丑: 0.03,
  寅: 0.026,
  卯: 0.122,
  辰: -0.034,
  午: 0.032,
  未: 0.022,
  申: -0.043,
  戌: 0.1,
};

function renderColophonLine(text: string) {
  return Array.from(text).map((char, index) => (
    <span
      className="ws-colophon-glyph"
      data-colophon-char={char}
      key={`${char}-${index}`}
      style={getGlyphStyle(char)}
    >
      {char}
    </span>
  ));
}

function getGlyphStyle(char: string): ColophonGlyphStyle | undefined {
  const x = COLOPHON_GLYPH_OFFSETS[char];
  if (!x) return undefined;
  return { "--ws-colophon-glyph-x": `${x}em` };
}

export function DocColophon({
  doc,
  placeholder = false,
}: {
  doc: ViewDocumentSnapshot | null;
  /**
   * 占位模式(审阅/编辑过渡态):落款这块奶白纸 + 同样高度的内容照常占位,
   * 但署名文字 / 印章不显现(opacity:0、不跑入场动画)。提交结清后由非占位的真落款
   * 接管、内容淡入。目的:审阅态就把落款空间留好,提交后只做"内容显现",不再凭空
   * 蹦出一整块、不跳布局。占位态不在末尾叠光标特效。
   */
  placeholder?: boolean;
}) {
  const count = useMemo(() => {
    if (!doc?.pmDoc) return 0;
    try {
      return countDocVisibleChars(doc.pmDoc);
    } catch {
      return 0;
    }
  }, [doc]);

  // 落款「最新修改时间」用文档快照时间戳 doc.ts(历史版本会显示该版本的真实时间,
  // 而非"今天查看时间");缺失才退化到当前时间。
  const dateText = useMemo(() => {
    const raw = doc?.ts ? new Date(doc.ts) : new Date();
    const d = Number.isNaN(raw.getTime()) ? new Date() : raw;
    return formatColophonDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }, [doc?.ts]);

  if (count <= 0) return null;

  return (
    <div
      className={`ws-colophon${placeholder ? " is-placeholder" : ""}`}
      data-wf="DocColophon"
      data-colophon-placeholder={placeholder ? "1" : undefined}
      aria-hidden="true"
    >
      {/* 竖排两列:左列「作于{干支年月初几}」,右列「成文{中文数字}字」+ 印章接字数下面。 */}
      <span className="ws-colophon-date">{renderColophonLine(`作于${dateText}`)}</span>
      <div className="ws-colophon-countcol">
        <span className="ws-colophon-count">
          {renderColophonLine(`成文${numberToChinese(count)}字`)}
        </span>
        <img
          className="ws-colophon-seal"
          src={SEAL_SRC}
          alt="空生妙有"
          draggable={false}
        />
      </div>
    </div>
  );
}
