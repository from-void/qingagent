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
import { useOverlayDismiss } from "../../system/overlayDismissStack";
import { CaretIcon } from "../../system/icons";
import { ensureSettingsDialogA11y } from "./settingsDialogA11y";
import type { ConnectorId, CredentialShareItem } from "@qingagent/contract-ts";
import { buildCredentialShareSpec, updateCredentialShare } from "./credentialShare";
import { resolveSkillDisplayMetadata } from "../../system/skillDisplay";

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
  switch (source) {
    case "builtin":
      return "内置";
    case "installed":
      return "已安装";
    case "external-claude":
      return "来自 Claude 目录";
    case "external-codex":
      return "来自 Codex 目录";
    case "external-shared":
      return "来自共享目录";
    default:
      return "来自共享目录";
  }
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
      <span className="sk-dep-go" aria-hidden="true"><CaretIcon size={13} direction="right" /></span>
    </button>
  );
}

export function SkillsPanel({ onOpenConnector }: { onOpenConnector?: (id: ConnectorId) => void } = {}) {
  const confirm = useConfirm();
  const {
    skills,
    loading,
    error,
    refresh,
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

  // 行右键菜单同样是浮层:Esc 交给面板级守卫走浮层关闭栈统一关,这里只留点击/滚动关闭
  useOverlayDismiss(Boolean(menu), () => setMenu(null));

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("scroll", close, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);

  // 瞬时反馈统一走 qa-toast:message 一有值就弹 toast 再清空(错误类走 error 底色)。
  useEffect(() => {
    if (!message) return;
    const isError = /失败|不可删除|错误|无法/.test(message);
    toast.show({ message, tone: isError ? "error" : "success" });
    setMessage(null);
  }, [message, toast]);

  // 启用后若该技能要共享命令行工具的登录信息,当场弹确认卡。
  // 卡面走设置层通用的确认弹层(useConfirm/FolderPromptDialog):有皮肤、有遮罩、
  // 焦点被困在卡里、Esc 只关它。文案仍由 buildCredentialShareSpec 单点产出。
  const askCredentialShare = async (items: CredentialShareItem[]) => {
    const spec = buildCredentialShareSpec(items);
    if (!spec) return;
    const accepted = await confirm({
      title: spec.title,
      ...(spec.sub ? { subject: spec.sub } : {}),
      message: spec.say,
      ...(spec.footHint ? { footHint: spec.footHint } : {}),
      confirmLabel: spec.primaryLabel,
      cancelLabel: spec.secondaryLabel,
      tone: "affirm",
    });
    if (!accepted) return;
    try {
      for (const item of items) {
        await updateCredentialShare({
          skillName: item.skillName,
          declared: item.declared,
          granted: true,
        });
      }
      if (mountedRef.current) {
        setMessage(`已允许「${items[0]!.skillLabel}」共享登录信息`);
      }
    } catch (error) {
      if (mountedRef.current) {
        setMessage(error instanceof Error ? error.message : "共享没有开启成功");
      }
    }
  };

  const toggle = async (name: string, enabled: boolean) => {
    setBusy(name);
    setMessage(null);
    try {
      const pending = (await setSkillEnabled(name, enabled)) ?? [];
      if (detail?.name === name && mountedRef.current) {
        setDetail({ ...detail, enabled });
      }
      if (pending.length > 0 && mountedRef.current) void askCredentialShare(pending);
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
    let installedName: string | null = null;
    try {
      let result: { name: string };
      if (lower.endsWith(".zip")) {
        result = await installZip(file);
      } else if (lower.endsWith(".md")) {
        result = await installSkillMd(await file.text());
      } else {
        throw new Error("仅支持 .zip 技能包或 .md 文件");
      }
      installedName = result.name;
      const importedDetail = await getSkillDetail(result.name);
      if (mountedRef.current) {
        setDetail(importedDetail);
        setSelectedName(result.name);
        toast.show({ message: "技能已导入", tone: "success" });
      }
    } catch (e) {
      if (!mountedRef.current) return;
      const reconciledName = skillInstallReconcileResult(e)?.name ?? installedName;
      if (reconciledName) {
        showSkillImportPartialReceipt({
          name: reconciledName,
          refresh,
          getSkillDetail,
          onReady: (latestDetail) => {
            if (!mountedRef.current) return;
            setDetail(latestDetail);
            setSelectedName(reconciledName);
            toast.show({ message: "技能列表已刷新", tone: "success" });
          },
          setBusy,
          toast,
        });
      } else {
        toast.show({
          message: safeSkillImportFailureMessage(e),
          tone: "warn",
          sticky: true,
          role: "alert",
          dedupeKey: "skill-import-failed",
          action: {
            label: "重新选择",
            onClick: () => fileInputRef.current?.click(),
          },
        });
      }
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
    if (!canMutate || s.source !== "installed") return;
    e.stopPropagation();
    setMenu({ name: s.name, builtin: false, title: s.label, x: e.clientX, y: e.clientY });
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
  const selectedChildren = selectedFromList?.children ?? [];
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
              <CaretIcon size={14} direction="left" />
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
                    <p>
                      随母技能「{resolveSkillDisplayMetadata(selectedFromList).displayName}」统一启用或停用
                    </p>
                  </div>
                  <span className="sk-card-tag">{selectedChildren.length} 项</span>
                </div>
                <div className="sk-child-list">
                  {selectedChildren.map((child) => {
                    const presentation = resolveSkillDisplayMetadata(child);
                    return (
                      <button
                        type="button"
                        className="sk-child-item"
                        data-wf="SkillChildEntry"
                        key={child.name}
                        onClick={() => setSelectedChildName(child.name)}
                      >
                        <SkIcon icon={child.icon} />
                        <span className="sk-child-copy">
                          <span className="sk-child-title">{presentation.displayName}</span>
                          <span className="sk-child-summary">{presentation.summary}</span>
                        </span>
                        <span className="sk-child-go" aria-hidden="true"><CaretIcon size={14} direction="right" /></span>
                      </button>
                    );
                  })}
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

  const skillGroups = [
    { title: "我的技能", skills: skills.filter((skill) => skill.source === "installed") },
    { title: "内置技能", skills: skills.filter((skill) => skill.source === "builtin") },
    {
      title: "共享技能",
      skills: skills.filter((skill) => skill.source.startsWith("external-")),
    },
  ].filter((group) => group.skills.length > 0);
  const showGroupTitles = skillGroups.length > 1;

  return (
    <div className="settings-skills" data-wf="SkillsPanel">
      <div className="sk-list-header">
        <p className="sm-note">
          模型可借助以下技能完成更复杂的任务。
          {!canMutate && "技能的导入与删除仅在桌面客户端开放。"}
        </p>
        {canMutate && (
          <button
            type="button"
            className="sk-import-btn"
            data-wf="SkillImportButton"
            title="支持 .zip 技能包或单个 .md 文件"
            disabled={busy === "__import__"}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy === "__import__" ? "导入中…" : "导入技能"}
          </button>
        )}
      </div>

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

      <div className="sk-groups">
        {skillGroups.map((group) => (
          <section className="sk-group" key={group.title}>
            {showGroupTitles && <h3 className="sk-group-title">{group.title}</h3>}
            <div className="sk-grid">
              {group.skills.map((s) => {
                const presentation = resolveSkillDisplayMetadata(s);
                return (
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
                      <span className="sk-card-title" title={presentation.displayName}>
                        {presentation.displayName}
                      </span>
                      <button
                        type="button"
                        className={`sk-toggle${s.enabled ? " sk-on" : ""}`}
                        disabled={busy === s.name}
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggle(s.name, !s.enabled);
                        }}
                        aria-pressed={s.enabled}
                        title={s.enabled
                          ? "停用后模型将不再使用该技能"
                          : "启用后模型可使用该技能"}
                      >
                        <span className="sk-toggle-dot" aria-hidden="true" />
                        {s.enabled ? "已启用" : "已停用"}
                      </button>
                    </div>
                    {/* 简介最多两行;子技能数量只在详情页展示,列表卡保持等高、保持轻。 */}
                    <p className="sk-card-summary">{presentation.summary}</p>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
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

function safeSkillImportFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  if (
    message === "仅支持 .zip 技能包或 .md 文件" ||
    (message.length > 0 && message.length <= 80 && /[\u3400-\u9fff]/u.test(message))
  ) {
    return message;
  }
  return "技能导入失败，请重试";
}

function skillInstallReconcileResult(error: unknown): { name: string } | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { name?: unknown; result?: unknown };
  if (
    record.name !== "SkillInstallReconcileError" ||
    !record.result ||
    typeof record.result !== "object"
  ) {
    return null;
  }
  const name = (record.result as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? { name } : null;
}

function showSkillImportPartialReceipt({
  name,
  refresh,
  getSkillDetail,
  onReady,
  setBusy,
  toast,
}: {
  name: string;
  refresh: () => Promise<SkillInfo[]>;
  getSkillDetail: (name: string, childName?: string) => Promise<SkillDetailInfo>;
  onReady: (detail: SkillDetailInfo) => void;
  setBusy: (value: string | null) => void;
  toast: ReturnType<typeof useToast>;
}): void {
  toast.show({
    message: "技能已安装，但列表尚未刷新",
    tone: "warn",
    sticky: true,
    role: "alert",
    dedupeKey: "skill-import-partial",
    action: {
      label: "重新加载",
      onClick: () => {
        setBusy("__import__");
        void refresh()
          .then(async (latest) => {
            if (!findSkillInList(latest, name)) {
              throw new Error("skill_not_visible");
            }
            return getSkillDetail(name);
          })
          .then(onReady)
          .catch(() => {
            showSkillImportPartialReceipt({
              name,
              refresh,
              getSkillDetail,
              onReady,
              setBusy,
              toast,
            });
          })
          .finally(() => setBusy(null));
      },
    },
  });
}

function findSkillInList(skills: readonly SkillInfo[], name: string): SkillInfo | null {
  for (const skill of skills) {
    if (skill.name === name) return skill;
    const child = findSkillInList(skill.children, name);
    if (child) return child;
  }
  return null;
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
  const childPresentation = resolveSkillDisplayMetadata(child);
  const parentPresentation = resolveSkillDisplayMetadata(parent);
  return (
    <div data-wf="SkillChildDetail">
      <div className="sk-detail-hero">
        <SkIcon icon={child.icon} />
        <span className="sk-detail-name">{childPresentation.displayName}</span>
      </div>
      <p className="sk-detail-meta">
        <span className="k">隶属：</span>{parentPresentation.displayName}
        {" · "}
        <span className="k">状态：</span>随母技能{parent.enabled ? "启用" : "停用"}
      </p>
      <div className="sk-md-body">
        <p>{childPresentation.summary}</p>
      </div>
      <h3 className="sk-detail-sec-title">技能正文(SKILL.md · 只读)</h3>
      <div className="sk-md-body" data-wf="SkillChildDetailBody">
        {showBodyLoading ? <p>加载中…</p> : null}
        {bodyError ? <p>{bodyError}</p> : null}
        {!bodyLoading && !bodyError ? renderSkillMarkdown(body) : null}
      </div>
      <p className="sm-note sk-child-inherited-note">
        此子技能不单独启停，由母技能「{parentPresentation.displayName}」统一控制。
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
  const isInstalled = skill.source === "installed";
  const presentation = resolveSkillDisplayMetadata(skill);
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
    if (!isInstalled || !canMutate || busy) return;
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
        {!isInstalled ? (
          <>
            <span className="sk-detail-name">{presentation.displayName}</span>
            {/* 只读来源改不了名，来源标直接跟在名字后面。 */}
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
                event.stopPropagation();
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
            aria-label={`编辑显示名：${presentation.displayName}`}
          >
            <span>{presentation.displayName}</span>
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
  const isInstalled = skill.source === "installed";
  const hint = !isInstalled
    ? "此来源为只读,仅可停用。"
    : canMutate
      ? "已安装技能可删除。"
      : "删除仅在桌面客户端开放。";
  return (
    <div className="sk-detail-foot" data-wf="SkillDeleteFoot">
      <span className="hint">{hint}</span>
      <button
        type="button"
        className="sk-btn-danger"
        disabled={!isInstalled || !canMutate || busy}
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
