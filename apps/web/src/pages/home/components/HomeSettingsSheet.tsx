import { useCallback, useEffect, useRef, useState } from "react";
import { ModelSettingsPanel } from "../../../overlays/settings/ModelSettingsPanel";
import { FeedbackPanel } from "../../../overlays/settings/FeedbackPanel";
import { ShortcutsPanel } from "../../../overlays/settings/ShortcutsPanel";
import { SkillsPanel } from "../../../overlays/settings/SkillsPanel";
import { ConnectionsPanel } from "../../../overlays/settings/ConnectionsPanel";
import type { ConnectorId } from "@qingagent/contract-ts";
import { AboutPanel } from "../../../overlays/settings/AboutPanel";
import { SecurityPanel } from "../../../overlays/settings/SecurityPanel";
import "../../../overlays/settings/settings.css";
import { SettingsInkBackdrop } from "./settingsInkVariants";
import type { SettingsInkVariantId } from "./settingsInkVariants/types";

// 全部设置统一从首页右上角 ⚙ 浮层进入。本组件渲染在 .qj-root 内,样式走青简 --qj-* 体系。
// tab:外观(明暗/字体/进场/动效) · 模型(看板) · 技能 · 搜索 · 快捷键。数据 tab 暂隐藏。

export type SettingsSheetTab = "appearance" | "model" | "skills" | "connections" | "security" | "diagnostics" | "shortcuts" | "about";

interface SheetOption<T extends string> {
  id: T;
  label: string;
}

interface HomeSettingsSheetProps<Mode extends string, AnimId extends string, Font extends string> {
  initialTab?: SettingsSheetTab;
  inkVariant: SettingsInkVariantId;
  themeMode: Mode;
  themeModeOptions: Array<SheetOption<Mode>>;
  anim: AnimId;
  animOptions: Array<SheetOption<AnimId>>;
  reduceMotion: boolean;
  primaryFont: Font;
  secondaryFont: Font;
  fontOptions: Array<SheetOption<Font>>;
  onThemeModeChange: (mode: Mode) => void;
  onAnimChange: (anim: AnimId) => void;
  onReduceMotionToggle: () => void;
  onPrimaryFontChange: (font: Font) => void;
  onSecondaryFontChange: (font: Font) => void;
  onOpenShelf?: () => void;
  onClose: () => void;
}

const TABS: Array<{ id: SettingsSheetTab; label: string }> = [
  { id: "model", label: "模型" },
  // 「外观」整组已隐藏:产品只保留浅色宣纸,无深/浅模式与外观设置。
  { id: "skills", label: "技能" },
  { id: "connections", label: "连接" },
  { id: "security", label: "安全" },
  { id: "shortcuts", label: "快捷键" },
  { id: "diagnostics", label: "反馈" },
  { id: "about", label: "关于" },
];

export function HomeSettingsSheet<Mode extends string, AnimId extends string, Font extends string>({
  initialTab,
  inkVariant,
  themeMode,
  themeModeOptions,
  anim,
  animOptions,
  reduceMotion,
  primaryFont,
  secondaryFont,
  fontOptions,
  onThemeModeChange,
  onAnimChange,
  onReduceMotionToggle,
  onPrimaryFontChange,
  onSecondaryFontChange,
  onOpenShelf,
  onClose,
}: HomeSettingsSheetProps<Mode, AnimId, Font>) {
  const [tab, setTab] = useState<SettingsSheetTab>(initialTab ?? "model");
  const [selectedConnectorId, setSelectedConnectorId] = useState<ConnectorId | null>(null);
  const [inkReady, setInkReady] = useState(false);
  const [closing, setClosing] = useState(false);
  // 墨退场比内容晚 160ms 触发:内容先淡出,墨再回收,避免墨先退留残影
  const [inkExiting, setInkExiting] = useState(false);

  // 关闭:先播墨退场动画(墨球四散+淡出),退场结束再真正卸载
  const handleClose = useCallback(() => {
    setClosing((prev) => {
      if (prev) return prev;
      // closing=true 让面板内容立即淡出;160ms 后再触发墨退场;墨退场结束再卸载
      window.setTimeout(() => setInkExiting(true), 160);
      window.setTimeout(onClose, 700);
      return true;
    });
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) handleClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handleClose]);

  // 焦点恢复(WCAG):挂载时记下打开弹层的触发元素(齿轮按钮),卸载时把焦点还回去——
  // 否则关闭后焦点丢到 body,键盘/读屏用户失去上下文(e2e v08-h2:overlays 设置经
  // settingsDialogA11y 有恢复,但首页 HomeSettingsSheet 原本没有)。
  // 健壮性:不能只靠"打开时触发元素有焦点"——鼠标点 <button> 在 Firefox/Safari-Mac
  // 默认不聚焦(activeElement 仍是 body),那样 openerRef 会记成 body、还原等于没还(e2e
  // v09-h1/h2 复现)。故 activeElement 不是有效可聚焦元素时,兜底按 aria-label 查齿轮按钮。
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement;
    openerRef.current =
      opener instanceof HTMLElement && opener !== document.body ? opener : null;
    return () => {
      const target =
        openerRef.current && document.body.contains(openerRef.current)
          ? openerRef.current
          : document.querySelector<HTMLElement>('button[aria-label="设置"]');
      target?.focus();
    };
  }, []);

  // 每次换 variant 重置揭幕态;并武装保底定时器:内容可见性(opacity)完全 gated 在
  // data-ink-ready 上,而该标志靠 ink 动画的 onRevealDone 触发——动画的 rAF 由
  // visibilityScheduler 调度,canvas 的 IntersectionObserver 一旦初判 isIntersecting=false
  // (负外延盒/开场布局未稳/headless 视口怪异)就 pause 永挂,onRevealDone 永不触发 →
  // 内容永远 opacity:0 只剩黑墨遮挡(e2e v04-h1 真机复现)。保底:各 variant REVEAL_MS≤~1.2s,
  // 1400ms 后无论动画是否回调都强制揭幕,正常态动画 onRevealDone 先赢、此兜底只兜卡死。
  useEffect(() => {
    setInkReady(false);
    const fallback = window.setTimeout(() => setInkReady(true), 1400);
    return () => window.clearTimeout(fallback);
  }, [inkVariant]);

  return (
    <div
      className="qj-sheet-backdrop"
      data-wf="HomeSettingsSheet"
      data-closing={closing ? "true" : "false"}
      onClick={handleClose}
    >
      <div
        className="qj-sheet"
        data-ink-ready={inkReady ? "true" : "false"}
        data-closing={closing ? "true" : "false"}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="qj-sheet-ink-stage" aria-hidden="true">
          <SettingsInkBackdrop variant={inkVariant} active={!inkExiting} onRevealDone={() => setInkReady(true)} />
        </div>
        {/* 关闭叉锚定到 .qj-sheet 外层右上角(而非内缩的 .qj-sheet-content),避免压住内容卡片 */}
        <button type="button" className="qj-sheet-close" aria-label="关闭" onClick={handleClose}>
          ✕
        </button>
        <div className="qj-sheet-content">
          <div className="qj-sheet-nav">
            <span className="qj-sheet-title">设 置</span>
            <nav className="qj-sheet-tabs" role="tablist" aria-label="设置分类">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  className={`qj-sheet-tab${tab === t.id ? " qj-active" : ""}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>
          <div className="qj-sheet-body" role="tabpanel">
            <div className="qj-sheet-panel" key={tab}>
            {tab === "appearance" && (
              <div className="qj-appear">
                <section className="qj-appear-grp">
                  <div className="qj-sp-glabel">明暗模式</div>
                  <div className="qj-swatch-row" role="group" aria-label="明暗模式">
                    {themeModeOptions.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`qj-swatch${themeMode === m.id ? " qj-active" : ""}`}
                        data-set={m.id}
                        aria-pressed={themeMode === m.id}
                        title={m.label}
                        onClick={() => onThemeModeChange(m.id)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="qj-appear-grp">
                  <div className="qj-sp-glabel">字体</div>
                  <div className="qj-font-row">
                    <label className="qj-font-field">
                      <span className="qj-font-name">主字体</span>
                      <select
                        className="qj-font-select"
                        value={primaryFont}
                        onChange={(e) => onPrimaryFontChange(e.target.value as Font)}
                      >
                        {fontOptions.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="qj-font-field">
                      <span className="qj-font-name">辅助字体</span>
                      <select
                        className="qj-font-select"
                        value={secondaryFont}
                        onChange={(e) => onSecondaryFontChange(e.target.value as Font)}
                      >
                        {fontOptions.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="qj-sp-hint">主字体用于标题与界面,辅助字体用于正文与说明</div>
                </section>

                <section className="qj-appear-grp">
                  <div className="qj-sp-glabel">进场动画</div>
                  <div className="qj-anim-row" role="group" aria-label="进场动画">
                    {animOptions.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className="qj-ap-mode"
                        data-anim={a.id}
                        aria-pressed={anim === a.id}
                        title={a.label}
                        onClick={() => onAnimChange(a.id)}
                      >
                        {a.label}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="qj-appear-grp qj-appear-grp--motion">
                  <button
                    type="button"
                    className={`qj-sp-row${reduceMotion ? " qj-on" : ""}`}
                    aria-pressed={reduceMotion}
                    title="减少动效"
                    onClick={onReduceMotionToggle}
                  >
                    <span>减少动效</span>
                    <span className="qj-bt-track">
                      <span className="qj-bt-knob" />
                    </span>
                  </button>
                  <div className="qj-sp-hint">勾选后关闭进场动画与滚动轻摆</div>
                </section>

                {onOpenShelf ? (
                  <section className="qj-appear-grp">
                    <div className="qj-sp-glabel">入口</div>
                    <button
                      type="button"
                      className="qj-sp-action"
                      onClick={() => {
                        onClose();
                        onOpenShelf();
                      }}
                    >
                      书阁 · 文档源
                    </button>
                  </section>
                ) : null}
              </div>
            )}
            {tab === "model" && <ModelSettingsPanel />}
            {tab === "skills" && <SkillsPanel onOpenConnector={(id) => {
              setSelectedConnectorId(id);
              setTab("connections");
            }} />}
            {tab === "connections" && (
              <ConnectionsPanel
                selectedId={selectedConnectorId}
                onSelectedIdChange={setSelectedConnectorId}
              />
            )}
            {tab === "security" && <SecurityPanel />}
            {tab === "diagnostics" && <FeedbackPanel />}
            {tab === "shortcuts" && <ShortcutsPanel />}
            {tab === "about" && <AboutPanel />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
