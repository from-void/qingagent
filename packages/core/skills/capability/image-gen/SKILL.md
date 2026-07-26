---
name: image-gen
label: 生成或修改图片
summary: 路由内置 SVG、本机 Codex 生图与现有图片修改
icon: image
description: 统一接收图片生成与修改意图，转诊结构化图表，检测桌面端本机 Codex，并按场景、可用能力和用户确认路由到 SVG 或 Codex 图片子技能。
user-invocable: true
placeholder: 描述要生成或修改的画面
tools: [generateSvg, prepareImageEditSource, importGeneratedImage]
metadata:
  category: capability
---

# 生成或修改图片

本技能是图片母技能，只负责意图接收、能力检测、必要反问和子技能路由。实际生成或修改前只读取被选中的一个子技能 `SKILL.md`，不要把两套执行细则同时塞进上下文。

## 一、先裁决是否应转诊图表

结构化图表不属于本技能，交给 `diagram-viz` 技能裁决。流程、关系、层次、时序、状态、系统架构、拓扑或其他结构化图表意图都不在本技能内生成。照片级写实图、氛围图、装饰插画、图标、自由构图，以及对用户指定现有图片的换色、改背景、局部替换、修图、P 图等修改，都属于本技能可承接的图片意图。

## 二、修改现有图片：桌面 Codex 确认路线

只要用户的目标是修改一张已经存在的图片，就先走本节；不要套用下方“从零生成”的 SVG/Codex 二选一，也不要把当前环境未配置说成产品完全没有图片编辑能力。

1. 先结合 system prompt 的“运行形态”判断当前是否为桌面客户端：
   - 非桌面环境：不要探测、不要调用源图准备工具；如实说明“图片修改能力需要桌面客户端调用本机 Codex，当前环境未配置这项本机能力”。不要说成产品绝对没有编辑图片能力，也不要用 SVG 重画冒充原图修改。
   - 桌面环境：继续做一次下述 Codex 可用性探测。
2. 复用从零生图路线的轻量探测：
   - POSIX：`command -v codex`；如需确认版本可改用 `codex --version`。
   - Windows：`where codex`。
   - 使用 `mastra_workspace_execute_command`，`timeout` 设为 5 秒。命令失败、超时、无输出或找不到可执行文件，都视为未安装；不重试，不向用户展示探测错误。
3. 未检测到 Codex：如实说明“桌面客户端已具备图片修改流程，但本机暂未检测到 Codex，安装并可用后才能处理这张图”。不要说“我不会 P 图”或“超出能力范围”，也不要擅自改走 SVG。
4. 检测到 Codex 后，必须确认用户是否同意把这次修改交给本机 Codex：
   - 用户已在本轮或可见上下文明确说“用本机 Codex 改”“就用 Codex P”或已经回答过这道确认，视为已经确认，不得重复询问。
   - 否则单独调用一次 `askUserQuestion`，不得与其他工具并发。只问一道单选题，参数形状照此生成：

   ```json
   {
     "id": "image-edit-codex-confirm",
     "rationale": "这项修改可以交给你本机的 Codex 处理，通常需要几分钟。",
     "questions": [{
       "header": "图片修改",
       "question": "是否使用本机 Codex 修改这张图片？",
       "multiSelect": false,
       "options": [
         {"value": "confirm", "label": "使用本机 Codex（推荐）", "description": "基于原图修改并把结果带回当前会话"},
         {"value": "cancel", "label": "暂不处理", "description": "保留原图，不启动本机任务"}
       ]
     }]
   }
   ```

5. 用户取消就明确说本次未启动、原图未改。用户确认后不得再次探测或反问；用 `skill_read` 只读取 `codex-image/SKILL.md`，随后严格按其中“修改现有图片”流程执行。

## 三、从零生成图片：SVG / Codex 路由流程

1. 先用 `mastra_workspace_execute_command` 做一次轻量、短超时探测：
   - POSIX：`command -v codex`；如需确认版本可改用 `codex --version`。
   - Windows：`where codex`。
   - `timeout` 设为 5 秒。命令失败、超时、无输出或找不到可执行文件，都视为未安装；不重试，也不把探测错误拿来打扰用户。
2. 未检测到 Codex 时只有一条可用路线：不反问，直接用 `skill_read` 读取 `svg/SKILL.md` 后执行。
3. 检测到 Codex，且用户此前已经明确说过“别问”“直接画”或同义要求时，不做方式反问，也不设固定默认；由你综合上下文和本次画面诉求裁决路线：
   - 用户说“按上次的搞法”“像之前那样”或其他指向历史的话时，去会话历史里确认上次实际走的是 SVG 还是 Codex 生图，并原样沿用。
   - 结合本会话乃至可见上下文里的生成习惯；用户此前多次选择同一条路线，是强信号。
   - 照片级写实、复杂光影或质感诉求优先考虑 Codex 生图；示意、图标、装饰或卡片优先考虑 SVG。
   - 信号仍不足时也由你拍板选择一条路线。动手时用一句话向用户说明“这次选了 X，因为 Y”，给用户纠错机会，再用 `skill_read` 读取所选子技能后执行。

   禁止不看上下文的机械默认。
4. 检测到 Codex，且用户没有要求免问时，必须单独调用一次 `askUserQuestion`，不得与其他工具并发。只问一道单选题“请选择本次配图方式”，只提供两项：
   - `内置 SVG 插画`：秒级、矢量，适合示意、装饰和图标。
   - `调度本机 codex 生图`：更强的图像生成，耗时几分钟。

   参数形状照此生成，不要增加第三项或自由文本题：

   ```json
   {
     "id": "image-gen-route",
     "rationale": "请选择更适合这次画面的生成方式。",
     "questions": [{
       "header": "配图方式",
       "question": "请选择本次配图方式",
       "multiSelect": false,
       "options": [
         {"value": "svg", "label": "内置 SVG 插画", "description": "秒级、矢量，适合示意、装饰和图标"},
         {"value": "codex-image", "label": "调度本机 codex 生图", "description": "更强的图像生成，耗时几分钟"}
       ]
     }]
   }
   ```

5. 问卷恢复并拿到选择后不得再次探测或反问。选择 SVG 就读取 `svg/SKILL.md`；选择 Codex 就读取 `codex-image/SKILL.md`，随后严格按该子技能执行。

## 四、未来扩展预留

未来若检测到用户配置的自定义生图模型，可在上述反问中增加第三项；配置机制待定，当前不得读取、猜测或实现任何配置。
