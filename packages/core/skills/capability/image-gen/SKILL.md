---
name: image-gen
label: 画配图
summary: 生成 SVG 插画与示意配图
icon: image
description: 为文档生成装饰性插画、图标、自由构图、氛围配图和数据示意卡，并通过 editDraft 插入文档。
user-invocable: true
placeholder: 描述画面
tools: [generateSvg]
metadata:
  category: capability
---

# SVG 配图

本技能只负责**生成式 SVG 插画资产**：装饰性插画、图标、自由构图、氛围配图和数据示意卡。结构化图表不属于本技能，交给 `diagram-viz` 技能裁决；照片级写实图当前未接入，不要用 SVG 硬凑。

## DOC-FIRST

1. 新文档先调用 `writeDraft` 生成并保存完整文字；已有文档先调用 `readDraft` 读取最新结构和目标块 `blockId`。不要在正文落地前先耗时出图。
2. 只选择 1-2 个确实能提升理解或氛围的位置。纯叙述已经清楚时不配图；一轮最多 3 张。
3. 调用 `generateSvg`，传中文 `description`，按需传 `style`、`aspect`；能套用对比卡、要点卡、数据条形卡时优先使用工具的 `template` 与 `params`。
4. 取得工具真实返回的 `src`、`width`、`height` 后，调用 `editDraft` 的 `insertBlock` 插入图片 QingML，不得编造路径或把 SVG 源码粘进正文：

```html
<img src="/api/v1/files/真实ID/illustration.svg" alt="简短说明" width="返回宽度" height="返回高度"/>
```

5. `position` 用 `after`/`before` 配合目标块 `ref`，或用 `start`/`end`；插入后用 `readDiff` 核对实际改动。不要再次调用 `writeDraft` 重发整篇来塞图。

## 约束

- 用户没有明确要求配图、插图、SVG、矢量图或自由示意图时，不主动调用。
- 只使用 `generateSvg` 返回的安全路径；失败后说明结果，不要盲目重复生成。
- 图是文档内容的辅助，不得压过正文信息层级。
