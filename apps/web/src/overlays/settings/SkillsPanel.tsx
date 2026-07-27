import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useToast } from "../../system/ToastProvider";
import { useDelayedVisible } from "../../system/useDelayedVisible";
import {
  useSkills,
  type SkillBaseInfo,
  type SkillDetailInfo,
  type SkillInfo,
} from "./useSkills";
import { SearchPanel } from "./SearchPanel";
import { VisionPanel } from "./VisionPanel";
import { useClientCapabilities, useConfirm } from "../../system";
import { normalizeSkillIconKey, SKILL_CARD_ICON_PATHS } from "../../system/skillIcons";
import { ensureSettingsDialogA11y } from "./settingsDialogA11y";
import type { ConnectorId } from "@qingagent/contract-ts";

ensureSettingsDialogA11y();

interface CtxMenu {
  name: string;
  builtin: boolean;
  title: string;
  x: number;
  y: number;
}


function SkIcon({ icon }: { icon: string }) {
  const iconKey = normalizeSkillIconKey(icon);
  return (
    <svg
      className="sk-card-icon"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {SKILL_CARD_ICON_PATHS[iconKey]}
    </svg>
  );
}

function sourceLabel(source: SkillBaseInfo["source"]): string {
  return source === "builtin" ? "内置" : "已安装";
}

function configTitle(config: string): string {
  if (config === "search-provider") return "配置 · 搜索引擎与 key";
  if (config === "vision-provider") return "配置 · 图像识别模型";
  return "配置";
}

function renderConfig(config: string | undefined): ReactNode {
  if (config === "search-provider") return <SearchPanel />;
  if (config === "vision-provider") return <VisionPanel />;
  return null;
}

const CONNECTOR_NAMES: Record<ConnectorId, string> = {
  github: "GitHub",
  feishu: "飞书",
  "wechat-mp": "微信公众号",
};

function ConnectorDependency({
  connectorId,
  onOpen,
}: {
  connectorId: ConnectorId;
  onOpen?: (id: ConnectorId) => void;
}) {
  return (
    <button
      type="button"
      className="sk-dep"
      onClick={(event) => {
        event.stopPropagation();
        onOpen?.(connectorId);
      }}
      title={`查看连接：${CONNECTOR_NAMES[connectorId]}`}
    >
      <span className="sk-dep-dot" aria-hidden="true" />
      依赖连接：<span className="sk-dep-name">{CONNECTOR_NAMES[connectorId]}</span>
      <span className="sk-dep-go" aria-hidden="true">›</span>
    </button>
  );
}

export function SkillsPanel({ onOpenConnector }: { onOpenConnector?: (id: ConnectorId) => void } = {}) {
  const confirm = useConfirm();
  const {
    skills,
    loading,
    error,
    setSkillEnabled,
    deleteSkill,
    installSkillMd,
    installZip,
    setSkillLabel,
    getSkillDetail,
  } = useSkills();
  const [busy, setBusy] = useState<string | null>(null);
  // message 是瞬时动作反馈(已删除/已导入/操作失败等)——统一用 qa-toast 弹出,不再嵌进界面。
  // 各处 setMessage 保持不动,由下面 effect 把它转成 toast 再清空。持久错误态(error/detailError)
  // 仍内联显示,不走 toast。
  const [message, setMessage] = useState<string | null>(null);
  const toast = useToast();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [selectedChildName, setSelectedChildName] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetailInfo | null>(null);
  const showListLoading = useDelayedVisible(loading && skills.length === 0);
  const [detailLoading, setDetailLoading] = useState(false);
  // 加载占位延迟 250ms 才显形,快请求不闪
  const showDetailLoading = useDelayedVisible(detailLoading);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [childDetail, setChildDetail] = useState<SkillDetailInfo | null>(null);
  const [childDetailLoading, setChildDetailLoading] = useState(false);
  const [childDetailError, setChildDetailError] = useState<string | null>(null);
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  const mountedRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const capabilities = useClientCapabilities();
  const canMutate = capabilities?.skills?.mutationEnabled === true;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedName) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    void getSkillDetail(selectedName)
      .then((data) => {
        if (!cancelled && mountedRef.current) setDetail(data);
      })
      .catch((e) => {
        if (!cancelled && mountedRef.current) {
          setDetail(null);
          setDetailError(e instanceof Error ? e.message : "技能详情加载失败");
        }
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedName, getSkillDetail]);

  useEffect(() => {
    if (!selectedName || !selectedChildName) {
      setChildDetail(null);
      setChildDetailError(null);
      setChildDetailLoading(false);
      return;
    }
    let cancelled = false;
    setChildDetail(null);
    setChildDetailLoading(true);
    setChildDetailError(null);
    void getSkillDetail(selectedName, selectedChildName)
      .then((data) => {
        if (!cancelled && mountedRef.current) setChildDetail(data);
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) {
          setChildDetail(null);
          setChildDetailError("子技能正文暂时无法加载");
        }
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setChildDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedName, selectedChildName, getSkillDetail]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // 瞬时反馈统一走 qa-toast:message 一有值就弹 toast 再清空(错误类走 error 底色)。
  useEffect(() => {
    if (!message) return;
    const isError = /失败|不可删除|错误|无法/.test(message);
    toast.show({ message, tone: isError ? "error" : "success" });
    setMessage(null);
  }, [message, toast]);

  const toggle = async (name: string, enabled: boolean) => {
    setBusy(name);
    setMessage(null);
    try {
      await setSkillEnabled(name, enabled);
      if (detail?.name === name && mountedRef.current) {
        setDetail({ ...detail, enabled });
      }
    } catch (e) {
      if (mountedRef.current) setMessage(e instanceof Error ? e.message : "操作失败");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const doDelete = async (name: string, title: string) => {
    setBusy(name);
    setMessage(null);
    try {
      await deleteSkill(name);
      if (mountedRef.current) {
        setSelectedName(null);
        setMessage(`已删除 ${title}`);
      }
    } catch (e) {
      if (mountedRef.current) setMessage(e instanceof Error ? e.message : "删除失败");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const handleImportFile = async (file: File) => {
    const lower = file.name.toLowerCase();
    setBusy("__import__");
    setMessage(null);
    try {
      let result: { name: string };
      if (lower.endsWith(".zip")) {
        result = await installZip(file);
      } else if (lower.endsWith(".md")) {
        result = await installSkillMd(await file.text());
      } else {
        throw new Error("仅支持 .zip 技能包或 .md 文件");
      }
      if (mountedRef.current) {
        setSelectedName(result.name);
        setMessage("技能已导入");
      }
    } catch (e) {
      if (mountedRef.current) setMessage(e instanceof Error ? e.message : "导入失败");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const saveLabel = async (name: string, label: string) => {
    setBusy(name);
    setMessage(null);
    try {
      const updated = await setSkillLabel(name, label);
      if (mountedRef.current) {
        setDetail(updated);
        setMessage("显示名已保存");
      }
    } catch (e) {
      if (mountedRef.current) setMessage(e instanceof Error ? e.message : "显示名保存失败");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const onFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void handleImportFile(file);
  };

  const confirmDelete = async (name: string, title: string, builtin: boolean) => {
    if (builtin) {
      setMessage(`「${title}」是内置技能,不可删除`);
      return;
    }
    const proceed = await confirm({
      title: `删除已安装技能「${title}」？`,
      message: "会移除本地安装内容，此操作不可恢复。",
      confirmLabel: "删除技能",
    });
    if (!proceed) return;
    void doDelete(name, title);
  };

  const handleMenuDelete = async () => {
    const m = menu;
    setMenu(null);
    if (!m) return;
    await confirmDelete(m.name, m.title, m.builtin);
  };

  const openMenu = (e: MouseEvent, s: SkillInfo) => {
    e.preventDefault();
    if (!canMutate) return;
    e.stopPropagation();
    setMenu({ name: s.name, builtin: s.source === "builtin", title: s.label, x: e.clientX, y: e.clientY });
  };

  const openSkill = (skill: SkillInfo) => {
    setSelectedChildName(null);
    setSelectedName(skill.name);
  };

  const openSkillByKey = (e: KeyboardEvent<HTMLDivElement>, skill: SkillInfo) => {
    if (e.currentTarget !== e.target) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openSkill(skill);
  };

  const selectedFromList = selectedName ? skills.find((skill) => skill.name === selectedName) ?? null : null;
  const selectedSkill = detail ?? selectedFromList;
  const selectedChildren = selectedFromList ? childSkills(selectedFromList) : [];
  const selectedParent = selectedFromList && selectedSkill
    ? { ...selectedFromList, enabled: selectedSkill.enabled }
    : selectedFromList;
  const selectedChild = selectedChildName
    ? selectedChildren.find((child) => child.name === selectedChildName) ?? null
    : null;

  if (selectedName) {
    return (
      <div className="settings-skills" data-wf="SkillsPanel">
        <div className="sk-subhead">
          <button
            type="button"
            className="sk-back"
            onClick={() => {
              if (selectedChild) {
                setSelectedChildName(null);
                return;
              }
              setSelectedName(null);
            }}
          >
            <span className="sk-back-arrow" aria-hidden="true">
              ‹
            </span>
            {selectedChild ? "返回母技能" : "返回技能"}
          </button>
          <span className="sk-subtitle">{selectedChild ? "子技能详情" : "技能详情"}</span>
        </div>

        {selectedChild && selectedParent ? (
          <ChildSkillDetail
            child={selectedChild}
            parent={selectedParent}
            body={childDetail?.body ?? ""}
            bodyLoading={childDetailLoading}
            bodyError={childDetailError}
          />
        ) : selectedSkill ? (
          <>
            <SkillDetail
              skill={selectedSkill}
              body={detail?.body ?? ""}
              bodyLoading={detailLoading}
              bodyError={detailError}
              busy={busy === selectedSkill.name}
              canMutate={canMutate}
              onToggle={(enabled) => void toggle(selectedSkill.name, enabled)}
              onSaveLabel={(label) => void saveLabel(selectedSkill.name, label)}
              onDelete={() => void confirmDelete(
                selectedSkill.name,
                selectedSkill.label,
                selectedSkill.source === "builtin",
              )}
              onOpenConnector={onOpenConnector}
            />
            {selectedFromList && selectedChildren.length > 0 && (
              <section className="sk-children-section" data-wf="SkillChildren">
                <div className="sk-children-heading">
                  <div>
                    <h3>子技能</h3>
                    <p>随母技能「{selectedFromList.label}」统一启用或停用</p>
                  </div>
                  <span className="sk-card-tag">{selectedChildren.length} 项</span>
                </div>
                <div className="sk-child-list">
                  {selectedChildren.map((child) => (
                    <button
                      type="button"
                      className="sk-child-item"
                      data-wf="SkillChildEntry"
                      key={child.name}
                      onClick={() => setSelectedChildName(child.name)}
                    >
                      <SkIcon icon={child.icon} />
                      <span className="sk-child-copy">
                        <span className="sk-child-title">{child.label}</span>
                        <span className="sk-child-summary">{child.summary || child.description}</span>
                      </span>
                      <span className="sk-child-go" aria-hidden="true">›</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <SkillDeleteFoot
              skill={selectedSkill}
              canMutate={canMutate}
              busy={busy === selectedSkill.name}
              onDelete={() => void confirmDelete(
                selectedSkill.name,
                selectedSkill.label,
                selectedSkill.source === "builtin",
              )}
            />
          </>
        ) : detailLoading ? (
          showDetailLoading ? <p className="sm-empty">加载中…</p> : null
        ) : (
          <p className="sm-message">{detailError ?? "技能不存在"}</p>
        )}
      </div>
    );
  }

  return (
    <div className="settings-skills" data-wf="SkillsPanel">
      <p className="sm-note" style={{ marginTop: 0 }}>
        停用后模型不再使用该技能；点击卡片查看详情。
        {canMutate ? "可导入 .zip 技能包或 .md 文件。" : "技能的导入与删除仅在桌面客户端开放。"}
      </p>

      {showListLoading && <p className="sm-empty">加载中…</p>}
      {error && <p className="sm-message">{error}</p>}

      {canMutate && (
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,.md"
          style={{ display: "none" }}
          data-wf="SkillImportInput"
          onChange={onFilePicked}
        />
      )}

      <div className="sk-grid">
        {skills.map((s) => (
          <div
            key={s.name}
            className={`sk-card${s.enabled ? "" : " sk-off"}`}
            data-wf="SkillEntry"
            role="button"
            tabIndex={0}
            onClick={() => openSkill(s)}
            onKeyDown={(e) => openSkillByKey(e, s)}
            onContextMenu={(e) => openMenu(e, s)}
          >
            <div className="sk-card-head">
              <SkIcon icon={s.icon} />
              <span className="sk-card-title">{s.label}</span>
              <button
                type="button"
                className={`sk-toggle${s.enabled ? " sk-on" : ""}`}
                disabled={busy === s.name}
                onClick={(e) => {
                  e.stopPropagation();
                  void toggle(s.name, !s.enabled);
                }}
                aria-pressed={s.enabled}
                title={s.enabled ? "停用" : "启用"}
              >
                <span className="sk-toggle-dot" aria-hidden="true" />
                {s.enabled ? "已启用" : "已停用"}
              </button>
            </div>
            {/* 简介最多两行;子技能数量只在详情页展示,列表卡保持等高、保持轻。 */}
            <p className="sk-card-summary">{s.summary}</p>
          </div>
        ))}

        {canMutate && (
          <button
            type="button"
            className="sk-card sk-card--import"
            data-wf="SkillImportCard"
            disabled={busy === "__import__"}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="sk-card-head">
              <svg
                className="sk-card-icon"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M10 3v9m0 0 3.2-3.2M10 12 6.8 8.8" />
                <path d="M3.6 13.4v1.6c0 .8.6 1.4 1.4 1.4h10c.8 0 1.4-.6 1.4-1.4v-1.6" />
              </svg>
              <span className="sk-card-title">{busy === "__import__" ? "导入中…" : "导入技能"}</span>
            </div>
            <p className="sk-card-desc">
              从本地选择 .zip 技能包或单个 .md 文件；声明 user-invocable 的技能导入即出现在输入框菜单。
            </p>
          </button>
        )}
      </div>

      {menu &&
        createPortal(
          <div className="sk-ctxmenu" style={{ left: menu.x, top: menu.y }} role="menu">
            <button
              type="button"
              className="sk-ctxmenu-item sk-ctxmenu-del"
              role="menuitem"
              onClick={() => void handleMenuDelete()}
            >
              删除技能
            </button>
          </div>,
          document.body,
        )}

      {!loading && !error && skills.length === 0 && <p className="sm-empty">暂无技能</p>}
    </div>
  );
}

function childSkills(skill: SkillInfo): SkillInfo[] {
  // 兼容升级期间旧服务响应，正式 API 始终返回 children 数组。
  return Array.isArray(skill.children) ? skill.children : [];
}

function ChildSkillDetail({
  child,
  parent,
  body,
  bodyLoading,
  bodyError,
}: {
  child: SkillInfo;
  parent: SkillInfo;
  body: string;
  bodyLoading: boolean;
  bodyError: string | null;
}) {
  const showBodyLoading = useDelayedVisible(bodyLoading && !body);
  return (
    <div data-wf="SkillChildDetail">
      <div className="sk-detail-hero">
        <SkIcon icon={child.icon} />
        <span className="sk-detail-name">{child.label}</span>
      </div>
      <p className="sk-detail-meta">
        <span className="k">隶属：</span>{parent.label}
        {" · "}
        <span className="k">状态：</span>随母技能{parent.enabled ? "启用" : "停用"}
      </p>
      <div className="sk-md-body">
        <p>{child.description || child.summary}</p>
      </div>
      <h3 className="sk-detail-sec-title">技能正文(SKILL.md · 只读)</h3>
      <div className="sk-md-body" data-wf="SkillChildDetailBody">
        {showBodyLoading ? <p>加载中…</p> : null}
        {bodyError ? <p>{bodyError}</p> : null}
        {!bodyLoading && !bodyError ? renderSkillMarkdown(body) : null}
      </div>
      <p className="sm-note sk-child-inherited-note">
        此子技能不单独启停，由母技能「{parent.label}」统一控制。
      </p>
    </div>
  );
}

function SkillDetail({
  skill,
  body,
  bodyLoading,
  bodyError,
  busy,
  canMutate,
  onToggle,
  onSaveLabel,
  onDelete,
  onOpenConnector,
}: {
  skill: SkillInfo | SkillDetailInfo;
  body: string;
  bodyLoading: boolean;
  bodyError: string | null;
  busy: boolean;
  canMutate: boolean;
  onToggle: (enabled: boolean) => void;
  onSaveLabel: (label: string) => void;
  onDelete: () => void;
  onOpenConnector?: (id: ConnectorId) => void;
}) {
  const showBodyLoading = useDelayedVisible(bodyLoading && !body);
  const [labelDraft, setLabelDraft] = useState(skill.label);
  const [editingLabel, setEditingLabel] = useState(false);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const configNode = renderConfig(skill.config);
  const isBuiltin = skill.source === "builtin";
  useEffect(() => {
    setLabelDraft(skill.label);
    setEditingLabel(false);
  }, [skill.name, skill.label]);
  useEffect(() => {
    if (!editingLabel) return;
    labelInputRef.current?.focus();
    labelInputRef.current?.select();
  }, [editingLabel]);
  const normalizedDraft = labelDraft.trim();
  const labelChanged = normalizedDraft.length > 0 && normalizedDraft !== skill.label;
  const beginLabelEdit = () => {
    if (!canMutate || busy) return;
    setLabelDraft(skill.label);
    setEditingLabel(true);
  };
  const cancelLabelEdit = () => {
    setLabelDraft(skill.label);
    setEditingLabel(false);
  };
  const commitLabelEdit = () => {
    setEditingLabel(false);
    if (labelChanged) {
      onSaveLabel(normalizedDraft);
    } else {
      setLabelDraft(skill.label);
    }
  };

  return (
    <>
      <div className="sk-detail-hero">
        <SkIcon icon={skill.icon} />
        {isBuiltin ? (
          <>
            <span className="sk-detail-name">{skill.label}</span>
            {/* 内置技能改不了名,来源标直接跟在名字后面,省掉单独一行元信息 */}
            <span className="sk-card-tag">{sourceLabel(skill.source)}</span>
          </>
        ) : editingLabel ? (
          <form
            className="sk-label-inline"
            onSubmit={(event) => {
              event.preventDefault();
              commitLabelEdit();
            }}
          >
            <input
              ref={labelInputRef}
              type="text"
              className="sk-label-input"
              value={labelDraft}
              data-wf="SkillLabelInput"
              aria-label="技能显示名"
              onChange={(event) => setLabelDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                cancelLabelEdit();
              }}
              onBlur={(event) => {
                if (
                  event.relatedTarget instanceof HTMLElement &&
                  event.relatedTarget.closest('[data-wf="SkillLabelSave"]')
                ) {
                  return;
                }
                commitLabelEdit();
              }}
            />
            <button
              type="submit"
              className="sk-label-save"
              disabled={!labelChanged}
              data-wf="SkillLabelSave"
              aria-label="保存显示名"
            >
              确认
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="sk-detail-name sk-detail-name-edit"
            disabled={!canMutate || busy}
            data-wf="SkillLabelEdit"
            onClick={beginLabelEdit}
            aria-label={`编辑显示名：${skill.label}`}
          >
            <span>{skill.label}</span>
            <svg
              className="sk-label-edit-icon"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m3 11.5-.5 2 2-.5 7.4-7.4-1.5-1.5L3 11.5Z" />
              <path d="m9.8 4.7 1.5 1.5" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={`sk-toggle${skill.enabled ? " sk-on" : ""}`}
          disabled={busy}
          onClick={() => onToggle(!skill.enabled)}
          aria-pressed={skill.enabled}
        >
          <span className="sk-toggle-dot" aria-hidden="true" />
          {skill.enabled ? "已启用" : "已停用"}
        </button>
      </div>

      {skill.connectorId && (
        <ConnectorDependency connectorId={skill.connectorId} onOpen={onOpenConnector} />
      )}

      {configNode && (
        <>
          <div className="sk-detail-sec-title">{configTitle(skill.config ?? "")}</div>
          {configNode}
        </>
      )}

      <div className="sk-detail-sec-title">技能正文(SKILL.md · 只读)</div>
      <div className="sk-md-body" data-wf="SkillDetailBody">
        {showBodyLoading ? <p>加载中…</p> : null}
        {bodyError ? <p>{bodyError}</p> : null}
        {!bodyLoading && !bodyError ? renderSkillMarkdown(body) : null}
      </div>

    </>
  );
}

/** 删除入口:整页最末(子技能之后),破坏性操作沿用红字惯例 */
function SkillDeleteFoot({
  skill,
  canMutate,
  busy,
  onDelete,
}: {
  skill: SkillBaseInfo;
  canMutate: boolean;
  busy: boolean;
  onDelete: () => void;
}) {
  const isBuiltin = skill.source === "builtin";
  const hint = isBuiltin
    ? "内置技能不可删除,仅可停用。"
    : canMutate
      ? "已安装技能可删除。"
      : "删除仅在桌面客户端开放。";
  return (
    <div className="sk-detail-foot" data-wf="SkillDeleteFoot">
      <span className="hint">{hint}</span>
      <button
        type="button"
        className="sk-btn-danger"
        disabled={isBuiltin || !canMutate || busy}
        onClick={onDelete}
      >
        删除技能
      </button>
    </div>
  );
}

function renderSkillMarkdown(markdown: string): ReactNode {
  const nodes: ReactNode[] = [];
  const lines = markdown.split(/\r?\n/);
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ").trim();
    if (text) nodes.push(<p key={`p-${nodes.length}`}>{renderInlineMarkdown(text)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    nodes.push(
      <ul key={`ul-${nodes.length}`}>
        {list.map((item, index) => (
          <li key={index}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  const flushCode = () => {
    if (!code) return;
    nodes.push(
      <pre key={`pre-${nodes.length}`}>
        <code>{code.join("\n")}</code>
      </pre>,
    );
    code = null;
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (code) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      nodes.push(<h4 key={`h-${nodes.length}`}>{renderInlineMarkdown(heading[1]!)}</h4>);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]!);
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  flushCode();
  return nodes.length > 0 ? nodes : <p>暂无正文</p>;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return <span key={index}>{part}</span>;
  });
}
