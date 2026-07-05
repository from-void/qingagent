import { SHORTCUT_GROUPS, SOURCE_LABELS, formatKey } from "./shortcutsRegistry";
import { ensureSettingsDialogA11y } from "./settingsDialogA11y";

ensureSettingsDialogA11y();

/** 快捷键一览面板(数据源 shortcutsRegistry,渲染处复用)。 */
export function ShortcutsPanel() {
  return (
    <div className="settings-shortcuts" data-wf="ShortcutsPanel">
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.id} className="sc-group">
          <h3 className="sc-group-title">{group.title}</h3>
          <ul className="sc-list">
            {group.items.map((item, i) => (
              <li key={i} className="sc-item">
                <span className="sc-label">
                  {item.label}
                  {SOURCE_LABELS[item.source] && (
                    <em className="sc-source">{SOURCE_LABELS[item.source]}</em>
                  )}
                </span>
                <span className="sc-keys">
                  {item.keys.map((k, j) => (
                    <kbd key={j} className="sc-kbd">
                      {formatKey(k)}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
