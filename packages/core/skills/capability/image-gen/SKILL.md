---
name: image-gen
label: 画配图
summary: 在内置 SVG 与本机 Codex 生图之间检测、询问并路由
icon: image
description: 统一接收文档配图意图，转诊结构化图表，检测本机 Codex，并按可用能力和用户选择路由到 SVG 或 Codex 生图子技能。
user-invocable: true
placeholder: 描述画面
tools: [generateSvg, importGeneratedImage]
metadata:
  category: capability
---

# 画配图

本技能是配图母技能，只负责意图接收、能力检测、必要反问和子技能路由。实际生成前只读取被选中的一个子技能 `SKILL.md`，不要把两套生成细则同时塞进上下文。

## 一、先裁决是否应转诊图表

结构化图表不属于本技能，交给 `diagram-viz` 技能裁决。流程、关系、层次、时序、状态、系统架构、拓扑或其他结构化图表意图都不在本技能内生成。照片级写实图、氛围图、装饰插画、图标和自由构图都属于本技能可承接的配图意图。

## 二、路由流程

1. 若用户此前已经明确说过“别问”“直接画”或同义要求，默认走内置 SVG，不做方式反问，直接用 `skill_read` 读取 `svg/SKILL.md` 后执行。
2. 其他情况先用 `mastra_workspace_execute_command` 做一次轻量、短超时探测：
   - POSIX：`command -v codex`；如需确认版本可改用 `codex --version`。
   - Windows：`where codex`。
   - `timeout` 设为 5 秒。命令失败、超时、无输出或找不到可执行文件，都视为未安装；不重试，也不把探测错误拿来打扰用户。
3. 未检测到 Codex 时只有一条可用路线：不反问，直接用 `skill_read` 读取 `svg/SKILL.md` 后执行。
4. 检测到 Codex 时，必须单独调用一次 `askUserQuestion`，不得与其他工具并发。只问一道单选题“请选择本次配图方式”，只提供两项：
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

## 三、未来扩展预留

未来若检测到用户配置的自定义生图模型，可在上述反问中增加第三项；配置机制待定，当前不得读取、猜测或实现任何配置。
