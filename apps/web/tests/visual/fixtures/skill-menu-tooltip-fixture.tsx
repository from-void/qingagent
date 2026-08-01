import "@qingagent/ui-kit";

import { createRoot } from "react-dom/client";
import { WorkspaceTooltip } from "../../../src/pages/workspace/components/WorkspaceTooltip";
import { SkillMenu } from "../../../src/system/SkillMenu";
import { invocableSkillActionsFromApi } from "../../../src/system/skillDisplay";
import "../../../src/app.css";
import "../../../src/pages/workspace/workspace.css";
import "../../../src/pages/workspace/workspace-ink-skin.css";

const skills = [
  {
    name: "lark-shared",
    label: "lark-shared",
    summary: "Use when first setting up lark-cli,…",
    description: "Use for lark-cli setup/auth tasks: auth login/status/logout, user vs bot identity, business-domain permissions (--domain, including all/docs/drive), missing scopes, revoking authorization, or handling _notice JSON.",
    icon: "star",
    enabled: true,
    userInvocable: true,
  },
  {
    name: "lark-note",
    label: "lark-note",
    summary: "飞书会议纪要（Note）直查",
    description: "飞书会议纪要（Note）直查：已知 note_id 时查询纪要详情、展示类型、关联文档 token，并读取 unified 原始逐字记录。",
    icon: "star",
    enabled: true,
    userInvocable: true,
  },
  {
    name: "lark-okr",
    label: "lark-okr",
    summary: "飞书 OKR",
    description: "飞书 OKR：管理目标与关键结果。",
    icon: "star",
    enabled: true,
    userInvocable: true,
  },
  {
    name: "lark-attendance",
    label: "lark-attendance",
    summary: "查询自己的考勤打卡记录",
    description: "查询自己的考勤打卡记录",
    icon: "star",
    enabled: true,
    userInvocable: true,
  },
  {
    name: "lark-calendar",
    label: "lark-calendar",
    summary: "管理日历日程和会议室",
    description: "管理日历日程和会议室",
    icon: "star",
    enabled: true,
    userInvocable: true,
  },
  {
    name: "skill-name-that-is-too-long-to-fit-inside-the-menu-even-without-description",
    label: "skill-name-that-is-too-long-to-fit-inside-the-menu-even-without-description",
    summary: "超长名称兜底",
    description: "超长名称兜底",
    icon: "star",
    enabled: true,
    userInvocable: true,
  },
];

function SkillMenuTooltipFixture() {
  return (
    <main id="view-workspace">
      <div className="skill-menu-fixture">
        <SkillMenu
          actions={invocableSkillActionsFromApi(skills)}
          onPick={() => undefined}
        />
      </div>
      <WorkspaceTooltip />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<SkillMenuTooltipFixture />);
