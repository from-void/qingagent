---
name: image-gen
label: 画配图
summary: 生成插画与示意图
icon: image
description: 统一出图入口。结构·流程·时序→Mermaid；工程架构·网络拓扑·部署·精确布局→drawio；矢量插画→generateSvg；照片级写实→(规划中)多模态生成。
user-invocable: true
placeholder: 描述画面
tools: [generateSvg]
metadata:
  category: capability
---

# 出图(图表与插图)

当用户想要任何形式的"图"时,先在这里判断意图属于哪一类,再走对应路径。四类:
**① 常规图表(Mermaid)** · **② 工程图/架构图(drawio)** · **③ 矢量插画(SVG)** · **④ 写实位图(多模态,规划中)**。

## 选哪条路

- **结构 / 流程 / 时序 / 关系 / 状态 / 对比 / 层级 / 思维导图 / 甘特 / 占比** → 走 **① Mermaid 图表块**。
  这类"确定性的图"用代码描述最准、可被用户继续编辑、能无损导出(PDF/Word/飞书),优先用它。
- **工程架构 / 网络拓扑 / 部署关系 / 工程框图 / 容器分组 / 精确坐标与复杂连线** → 走 **② drawio 图表块**。
- **矢量插画 / 装饰配图 / 图标 / 概念示意(无严格结构)** → 走 **③ generateSvg(SVG)**。
- **照片级写实 / 真实场景图** → **④ 多模态生成**,当前尚未接入;如用户要,告知"写实出图能力即将上线",不要用前三条硬凑。

## ① Mermaid 图表块(首选,确定性)

在写文/改文时,直接产出 `diagram` 块(经 writeDraft / editDraft 的 AI-IR):

```json
{"type":"diagram","lang":"mermaid","source":"flowchart TD\n  A[开始] --> B{判断}\n  B -->|是| C[执行]\n  B -->|否| D[结束]"}
```

- `source` 是 Mermaid 源码;支持 flowchart(流程)、sequenceDiagram(时序)、classDiagram(类)、stateDiagram(状态)、erDiagram、gantt(甘特)、pie(饼)、mindmap(思维导图)。
- 前端会把 source 渲染成图并缓存,导出 PDF/Word 用渲染图、导出飞书用源码出画板。**svg 字段不用填**(客户端渲染)。
- 用户可在编辑器里双击图表手工改源码,所以图表是"活"的——不要用代码块或 ASCII 伪造图表。
- 插入位置:与普通块一样,放在它说明的那段文字附近。

## ② drawio 工程图/架构图(确定性)

在 writeDraft / editDraft 的 QingML 中使用 `<drawio>…</drawio>`。正文必须是转义后的**未压缩 mxGraphModel XML**，不能输出 base64/deflate：

```html
<drawio>&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id="0"/&gt;&lt;mxCell id="1" parent="0"/&gt;&lt;mxCell id="api" value="API" style="rounded=0;whiteSpace=wrap;html=0;" vertex="1" parent="1"&gt;&lt;mxGeometry x="40" y="40" width="120" height="60" as="geometry"/&gt;&lt;/mxCell&gt;&lt;mxCell id="db" value="数据库" style="shape=cylinder;whiteSpace=wrap;html=0;" vertex="1" parent="1"&gt;&lt;mxGeometry x="240" y="40" width="120" height="60" as="geometry"/&gt;&lt;/mxCell&gt;&lt;mxCell id="edge-1" edge="1" parent="1" source="api" target="db"&gt;&lt;mxGeometry relative="1" as="geometry"/&gt;&lt;/mxCell&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;</drawio>
```

- `mxCell vertex="1"` 是节点，必须有带 x/y/width/height 的 `mxGeometry`；`edge="1"` 是边，必须有 source/target 与 `relative="1"` geometry。
- 编辑已有图时保留稳定 mxCell id，只改目标节点、geometry、样式或边；不要整体重铸 id。
- XML 中禁止脚本、链接、外部图片和可执行 HTML。`svg` 不用填，客户端离线渲染并安全缓存。

## ③ generateSvg(SVG 矢量插画)

仍是 **DOC-FIRST**(硬性顺序):

1. 先用 `generateDoc` 生成**完整文本文档**(不含任何图),文档立即保存。绝不在出文前生成图——图生成慢会耗尽整轮预算导致文档丢失。
2. 文档保存后,判断 1-2 处最值得配图处;每处调 `generateSvg`(传中文描述,可选 `style` 简约线条/扁平填色/等距3D、`aspect` 默认 16:9),拿到真实 `src` 后传 `insertAfterSectionIndex`(目标段 section 序号,从 0 起,-1 = 文末)增量插入。
3. 插多张:每次插入会让其后 section 序号 +1,**按序号从大到小**依次插,避免错位。
4. 数量上限(硬性):长文(>800字)最多 1-2 张,短文 0-1 张,**一轮绝不超过 3 张**。
5. 不要用第二次 `generateDoc` 重发带图整篇(会触发覆盖拦截);一律用工具返回的 `src`(形如 `/api/v1/files/<id>/illustration.svg`),勿编造路径或把 SVG 粘进正文。

## 通用约束

- 用户没要求配图就别主动配图;一篇通常 0-3 张图,勿滥用。
- 纯叙述段落、信息已足够清楚时不配图。
