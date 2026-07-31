---
name: review
label: 文档审查
summary: 统一执行八类文档审查
icon: review
description: 文档审查总技能，统一路由敏感词、来源核查、去 AI 味、一致性、隐私、格式规范、角色与自定义审查；按需读取对应子技能后执行。
user-invocable: true
placeholder: 审查当前文档
tools: [lexicon_list, sensitive_scan, lexicon_manage, style_template_get, readDraft, readMaterial, run_python, run_js, editDraft, create_annotation_groups]
metadata:
  category: capability
---

# 文档审查

本技能统一承载八类文档审查。先按下表判断审查类型，再用 `skill_read` 读取对应相对路径下的子技能 `SKILL.md`；用户同时要求多类审查时逐个读取所需文件，不要无差别加载全部子技能。

## 路由表

| 类型 | 触发词或入口 | 执行前必读 |
|---|---|---|
| 敏感词审查 | 敏感词、违禁词、极限词审查，或管理审查词库 | `sensitive/SKILL.md` |
| 来源核查 | 来源审查、来源核查、核对依据、是否按素材写 | `source-check/SKILL.md` |
| 去 AI 味 | 去AI味、像人写的、去机器味、humanize | `deai/SKILL.md` |
| 一致性审查 | 一致性审查、自洽核查、前后矛盾检查、数字一致性 | `consistency/SKILL.md` |
| 隐私审查 | 隐私泄露审查、隐私检查、脱敏检查、对外发布泄露检查 | `privacy/SKILL.md` |
| 格式审查 | 格式规范审查、格式检查、版式校对、交付前格式整备 | `format/SKILL.md` |
| 角色审查 | 角色审查、点名审查角色，或 query 携带角色审查模板 | `role/SKILL.md` |
| 自定义审查 | 自定义审查、点名自定义模板，或 query 携带自定义审查模板 | `custom/SKILL.md` |

## 公共执行纪律

### 两种执行形态

1. **单独审查当前文档**（包括菜单 query）：纯批注模式，不改稿。先 `readDraft` 读取当前全文，确定问题统一用 `create_annotation_groups` 呈现，由用户逐条处理。唯一例外是敏感词词库中带明确 `replacement` 的命中，仍按敏感词 reference 直接做逐处最小替换。
2. **写作流程内联审查**：只有用户在最初写作意图里同时明确要求“写文章并在写完后做某审查”时才使用。`writeDraft` 产出候选后，必须在同一 agent 回合继续 `readDraft` 候选并按模板自查；明确问题直接用 `editDraft` 修复，修复后重新读取复核，最后才让候选 settle。不得先交初稿再产一批批注；已修复问题不产批注，存疑或需用户裁量的发现只在聊天中克制说明。
3. `writeDraft` / `editDraft` 会把最新候选同步给后续工具，不改候选 settle 引擎，不另造审查工作流。收到“[正文已更新]”提示时必须重新 `readDraft`，不得沿用历史读取结果。

### 模板与批注契约

1. 菜单 query 已携带所选模板的完整 prompt 和模板名，必须完整执行；文档级补充只约束当前文档，不得覆盖模板硬规则。
2. 单独审查只把确定问题交给 `create_annotation_groups`；没有确定问题时不调用。敏感词 `reviewAction:"annotate"` 是例外：全部命中都必须呈现，拿不准时也不得丢弃。
3. 每组 `summary` 只写不超过 15 字的变更类型短标题；判定、依据、验算式和上下文写入 `note`；可执行修改写入 `suggestion`。`anchors[].find` 必须逐字存在于当前正文，不得用改写文本或模糊整段代替。
4. 只有模板明确要求严重度时才传 `severity:"error"|"warn"|"info"`；模板未要求时省略，禁止自行分级。
5. `origin` 命名固定为：敏感词=`sensitive`、去 AI 味=`deai`、来源核查=`source-check`、一致性=`consistency`、隐私=`privacy`、格式=`format`、角色审查=`角色审查:<模板名>`、自定义审查=`自定义审查:<模板名>`。模板名必须与 query 中名称逐字一致。
6. 同一固定 `origin` 或同名角色/自定义模板重跑时换代旧结果；不同角色或自定义模板使用不同 `origin`，结果可以共存。
7. `create_annotation_groups` 返回参数解析失败时，拆成小批重试（每次不超过 3 组），不得把调用失败当成没有问题或空手结束。
8. `privacy` / `sensitive` 发现若含手机号、身份证、银行卡或邮箱，只有用于精确定位的 `anchors[].find` 可以填写正文原值；`summary`、`note`、`suggestion` 与聊天审查摘要必须使用打码值（如 `139****5678`），禁止复述完整敏感值。
