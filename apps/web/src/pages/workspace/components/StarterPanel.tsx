import { useState } from "react";
import { SkinSelect } from "../../../system/SkinSelect";
import {
  STARTER_INDUSTRIES,
  findStarterTemplate,
  type StarterTemplate,
  type StarterTemplateBlock,
} from "../data/starterTemplates";
import { useStarterFavorites } from "../data/useStarterFavorites";
import "./starterPanel.css";

export type StarterBlankTarget = "body";

interface StarterPanelProps {
  /** 点击模板卡「填充」:把骨架写入空文档(并触发会话/文档的惰性创建) */
  onFill: (template: StarterTemplate) => void;
  /** 点击空态正文区域:先创建本地最小合法文档,再把光标定位到正文首行。 */
  onCreateBlank: (target: StarterBlankTarget) => void;
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill={filled ? "var(--mark)" : "none"} stroke="var(--mark)" strokeWidth="1.4">
      <path d="M12 2l3 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.9 21l1.2-6.8-5-4.9 6.9-1z" />
    </svg>
  );
}

// 预览块与编辑器同构 DOM(用户反馈:预览排版必须和编辑器一模一样)——外层挂 .wf-doc 类,
// 这里只输出与 TipTap 渲染一致的语义标签(h1-h6/p/ul/ol/table/ul[data-type=taskList]>li>label+div),
// 字号/行距/间距/勾选框全部由编辑器现成样式接管,不再自定义任何排版数值。
function StarterPreviewBlock({ block, index }: { block: StarterTemplateBlock; index: number }) {
  switch (block.type) {
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      const Tag = `h${level}` as "h1";
      return <Tag>{block.text}</Tag>;
    }
    case "paragraph":
      return <p>{block.text}</p>;
    case "bulletList":
      return (
        <ul>
          {block.items.slice(0, index > 5 ? 1 : 3).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case "orderedList":
      return (
        <ol>
          {block.items.slice(0, index > 5 ? 1 : 3).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      );
    case "taskList":
      return (
        <ul data-type="taskList">
          {block.items.slice(0, 3).map((item) => (
            <li key={item.text} data-checked={item.checked ? "true" : "false"}>
              <label>
                <input className="wf-checkbox" type="checkbox" checked={!!item.checked} readOnly tabIndex={-1} />
              </label>
              <div>
                <p>{item.text}</p>
              </div>
            </li>
          ))}
        </ul>
      );
    case "table":
      return (
        <table>
          <tbody>
            {block.rows.slice(0, 3).map((row, rowIndex) => (
              <tr key={row.cells.map((cell) => cell.text).join("|") || rowIndex}>
                {row.cells.slice(0, 4).map((cell, cellIndex) =>
                  cell.header ? (
                    <th key={`${cell.text}-${cellIndex}`}>{cell.text}</th>
                  ) : (
                    <td key={`${cell.text}-${cellIndex}`}>{cell.text}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

/**
 * 空文档「引导态」:进编辑页未操作时右侧展示。顶部只保留正文首行入口 + 沉底模板区。
 * 模板区:一级 tab(推荐 / 收藏,无收藏时只显推荐)、推荐按行业下拉筛选(收藏不分行业)、
 * A4 比例小卡横排、hover 点击填充、右上角五角星收藏(客户端级持久化)。
 */
export function StarterPanel({ onFill, onCreateBlank }: StarterPanelProps) {
  const [tab, setTab] = useState<"recommend" | "favorite">("recommend");
  const [industryId, setIndustryId] = useState(STARTER_INDUSTRIES[0]!.id);
  // hover 卡片时把该模板骨架预填进文档区预览(不落库),移开消失
  const [hovered, setHovered] = useState<StarterTemplate | null>(null);
  const fav = useStarterFavorites();

  const industry = STARTER_INDUSTRIES.find((i) => i.id === industryId) ?? STARTER_INDUSTRIES[0]!;
  const favTemplates = fav.ids
    .map(findStarterTemplate)
    .filter((t): t is StarterTemplate => !!t);
  const showFavoriteTab = fav.ids.length > 0;
  // 收藏被清空且当前在收藏 tab 时,回退到推荐
  const activeTab = tab === "favorite" && !showFavoriteTab ? "recommend" : tab;
  const cards = activeTab === "recommend" ? industry.templates : favTemplates;
  // 卡片列表身份(tab / 行业 / 成员)一变就清 hover 预览:此时旧卡片 unmount(或整列重建),
  // onMouseLeave 永远不会触发,hovered 残留会让预览卡死在已消失的卡上、顶掉"输入正文"空态入口
  // (真机复现:收藏 tab hover 时点星取消收藏)。按 id 派生校验挡不住——收藏与推荐共享同一批模板 id。
  // 用 render 期间 adjust-state(React 官方模式)避免 effect 的一帧闪烁。
  const cardsKey = `${activeTab}|${industryId}|${cards.map((t) => t.id).join(",")}`;
  const [prevCardsKey, setPrevCardsKey] = useState(cardsKey);
  if (prevCardsKey !== cardsKey) {
    setPrevCardsKey(cardsKey);
    if (hovered) setHovered(null);
  }

  return (
    <div className="starter-empty" data-wf="StarterPanel">
      <div className="starter-doc">
        {hovered ? (
          <div className="starter-preview wf-doc" aria-hidden>
            {hovered.blocks.slice(0, 9).map((block, i) => (
              <StarterPreviewBlock key={`${block.type}-${i}`} block={block} index={i} />
            ))}
          </div>
        ) : (
          <div className="starter-head">
            <button
              type="button"
              className="starter-hit starter-hit-body"
              onClick={() => onCreateBlank("body")}
            >
              <span className="starter-h1">输入正文,开始写作</span>
            </button>
          </div>
        )}
        <div className="starter-tplzone">
          <div className="starter-bar">
            <div className="starter-tabs">
              <button
                type="button"
                className={`starter-tab ${activeTab === "recommend" ? "on" : ""}`}
                onClick={() => setTab("recommend")}
              >
                推荐
              </button>
              {showFavoriteTab && (
                <button
                  type="button"
                  className={`starter-tab ${activeTab === "favorite" ? "on" : ""}`}
                  onClick={() => setTab("favorite")}
                >
                  收藏
                </button>
              )}
            </div>
            {activeTab === "recommend" && (
              <div className="starter-sel">
                <SkinSelect
                  value={industryId}
                  onChange={setIndustryId}
                  ariaLabel="选择行业"
                  skin="paper"
                  options={STARTER_INDUSTRIES.map((industry) => ({
                    value: industry.id,
                    label: industry.name,
                  }))}
                />
              </div>
            )}
          </div>
          {cards.length === 0 ? (
            <div className="starter-empty-fav">
              在「推荐」里点卡片右上角五角星即可收藏;收藏不分行业,任意行业下都能取用。
            </div>
          ) : (
            <div className="starter-cards" key={`${activeTab}-${industryId}`}>
              {cards.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className="starter-card"
                  onClick={() => onFill(t)}
                  onMouseEnter={() => setHovered(t)}
                  onMouseLeave={() => setHovered((cur) => (cur === t ? null : cur))}
                >
                  <span
                    className="starter-star"
                    role="button"
                    tabIndex={-1}
                    aria-label={fav.isFavorite(t.id) ? "取消收藏" : "收藏"}
                    onClick={(e) => {
                      e.stopPropagation();
                      fav.toggle(t.id);
                    }}
                  >
                    <StarIcon filled={fav.isFavorite(t.id)} />
                  </span>
                  <span className="starter-name">{t.name}</span>
                  <span className="starter-desc">{t.desc}</span>
                  <span className="starter-fill">点击填充</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
