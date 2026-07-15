import { RoleAvatar, type RoleAvatarKind } from "../roleReview";

export interface LaunchTemplateItem {
  id: string;
  name: string;
  summary: string;
  portraitDetail?: string;
  avatarKind?: RoleAvatarKind;
  recommended?: boolean;
}

export function buildTemplateSummary(detail: string, prompt: string, max = 58): string {
  const source = detail.trim() || prompt.split(/\r?\n/, 1)[0] || prompt;
  const value = source.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function TemplateGroup(props: {
  label: string;
  ariaLabel: string;
  items: LaunchTemplateItem[];
  selectedId: string | null;
  variant?: "default" | "portrait";
  disabled?: boolean;
  onSelect: (id: string) => void;
  onEdit: (item: LaunchTemplateItem) => void;
  onCreate: () => void;
}) {
  return (
    <section className="ws-launch-template-group">
      <div className="ws-launch-template-group-head">
        <h3 className="ws-launch-template-group-title">{props.label}</h3>
        <button type="button" className="ws-launch-template-new" disabled={props.disabled} onClick={props.onCreate}>＋ 新建</button>
      </div>
      <div className={`ws-launch-template-grid${props.variant === "portrait" ? " is-portrait" : ""}`} role="radiogroup" aria-label={props.ariaLabel} aria-busy={props.disabled || undefined}>
        {props.items.map((item) => (
          <div className={`ws-launch-template-card${props.variant === "portrait" ? " is-portrait" : ""}${item.id === props.selectedId ? " is-selected" : ""}`} key={item.id}>
            <button
              type="button"
              className="ws-launch-template-select"
              role="radio"
              aria-checked={item.id === props.selectedId}
              disabled={props.disabled}
              onClick={() => props.onSelect(item.id)}
            >
              {props.variant === "portrait" ? (
                <>
                  {item.recommended ? <span className="ws-launch-role-recommended">推荐</span> : null}
                  <span className="ws-launch-role-avatar"><RoleAvatar kind={item.avatarKind ?? "generic"} /></span>
                  <span className="ws-launch-template-name"><strong title={item.name}>{item.name}</strong></span>
                  <span className="ws-launch-role-position">{item.portraitDetail ?? "自定义角色"}</span>
                </>
              ) : (
                <>
                  <span className="ws-launch-template-name"><strong>{item.name}</strong></span>
                  <span className="ws-launch-template-summary">{item.summary}</span>
                </>
              )}
            </button>
            <button
              type="button"
              className="ws-launch-template-edit"
              aria-label={`编辑${item.name}`}
              title="编辑模板"
              disabled={props.disabled}
              onClick={() => props.onEdit(item)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M11.1 2.9a1.75 1.75 0 0 1 2.47 2.47L6 12.9l-3.2.77.77-3.2Z" />
                <path d="m9.7 4.3 2.47 2.47" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
