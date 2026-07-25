# Mermaid flowchart 自研管线特性矩阵

基准：Mermaid 11.16 官方 [Flowcharts Syntax](https://mermaid.js.org/syntax/flowchart.html)。

范围：`packages/diagram-engine` 的解析与共享布局、`GraphDiagramView` 的 React Flow 保存态、
`graphToSvg` 的导出/缓存静态 SVG。编辑态 Mermaid.js 只作为对照，不参与保存态路由。

状态定义：

- **支持**：解析、布局、React Flow、SVG 四段均有对应实现；适用时有自动化证据。
- **部分**：核心语义可见，但官方语法的某个可见细节仍未完全实现。
- **缺失**：保存态会丢失该语义。
- **不适用**：产品因安全或确定性导出约束明确禁用，并说明行为。

## 初始盘点（修复前）

| 类别 | 特性 | 初始状态 | 直接证据 |
|---|---|---:|---|
| 子图 | 容器、标题、嵌套 | 缺失 | 解析器虽产出 `subgraphs/scopePath`，`GraphDiagramView` 与 `graphToSvg` 均零消费 |
| 子图 | 内部 `direction` | 缺失 | `direction` 行只进入 `protectedSpans` |
| 子图 | 边到 subgraph id | 缺失 | subgraph id 被误建成普通隐式节点 |
| 边 | 实/虚/粗、正反/双向/无箭头 | 部分 | React 支持主变体；SVG 固定实线、固定正向箭头 |
| 边 | `|标签|` | 部分 | 可解析；引号标签保留多余引号 |
| 边 | `-- 标签 -->` | 缺失 | 被误判为简单边且丢标签 |
| 边 | 链式、多源/多目标 | 缺失 | 多箭头或 `&` 直接拒绝 |
| 边 | `~~~` | 缺失 | 无 token、无布局约束 |
| 边 | `linkStyle` | 缺失 | 只设置 `hasLinkStyle`，不进入渲染样式 |
| 节点 | 经典括号形状 | 部分 | 解析 10 种、React 归一为 11 种；缺双圆、非对称、正反梯形等；SVG 全画圆角矩形 |
| 节点 | Mermaid 11.3 `@{ shape: ... }` 扩展形状 | 缺失 | `@{}` 只被标为 unsupported |
| 样式 | `classDef/class/:::` | 部分 | 节点基本色可用；多 classDef、default、dash/font-size 不完整 |
| 样式 | `style` | 缺失 | 整行保护，不进入渲染 |
| 样式 | init `themeVariables` | 支持 | W15 已覆盖；但 cluster 色板没有消费者 |
| 其他 | `%%` 注释 | 支持 | 独立行保护；尾注释可剥离 |
| 其他 | 引号、实体、转义 | 部分 | `<br>` 可见；括号内 `]`、转义引号、HTML entity 不完整 |
| 其他 | `TB/TD/LR/BT/RL` | 部分 | React 布局支持；SVG 固定网格 |

## 完成后矩阵

| 类别 | 官方语法/行为 | 解析 | 共享布局 | React Flow | `graphToSvg` | 状态与证据 |
|---|---|---:|---:|---:|---:|---|
| 子图 | 容器矩形与标题 | ✓ | ✓ | ✓ | ✓ | **支持**；真实 fixture 8/8 容器 |
| 子图 | 显式 `id["标题"]` | ✓ | ✓ | ✓ | ✓ | **支持**；id 与 label 分离，不再造隐式节点 |
| 子图 | 任意层嵌套 | ✓ | ✓ | ✓ | ✓ | **支持**；递归超节点布局，父容器包住子容器 |
| 子图 | 内部 `direction TB/TD/LR/BT/RL` | ✓ | ✓ | ✓ | ✓ | **支持**；遵循 Mermaid 官方限制：子图节点直接连外部时继承父方向 |
| 子图 | 边连到 subgraph id | ✓ | ✓ | ✓ | ✓ | **支持**；以容器边界作为端点 |
| 子图 | 拖动节点后容器包围 | — | ✓ | ✓ | ✓ | **支持**；overlay 进入共享布局，容器按所属节点/子容器重新扩张 |
| 边 | 实线 `-->`/`---` | ✓ | ✓ | ✓ | ✓ | **支持** |
| 边 | 虚线 `-.->`/`-.-` | ✓ | ✓ | ✓ | ✓ | **支持** |
| 边 | 粗线 `==>`/`===` | ✓ | ✓ | ✓ | ✓ | **支持** |
| 边 | 正向、反向、双向、无箭头 | ✓ | ✓ | ✓ | ✓ | **支持**；两端 marker 独立 |
| 边 | 圆头、叉头 | ✓ | ✓ | ✓ | ✓ | **支持**；`--o/--x/o--o/x--x/o--x` |
| 边 | `-->|标签|` | ✓ | ✓ | ✓ | ✓ | **支持**；去除合法包裹引号 |
| 边 | `-- 标签 -->`、`-. 标签 .->`、`== 标签 ==>` | ✓ | ✓ | ✓ | ✓ | **支持** |
| 边 | 链式 `A-->B-->C` | ✓ | ✓ | ✓ | ✓ | **支持**；展开为稳定边序列 |
| 边 | 多源/多目标 `A & B --> C & D` | ✓ | ✓ | ✓ | ✓ | **支持**；展开笛卡尔积 |
| 边 | 不可见边 `~~~` | ✓ | ✓ | ✓ | ✓ | **支持**；参与布局、视觉隐藏 |
| 边 | 加长 link token | ✓ | ✓ | ✓ | ✓ | **支持**；接受额外 `-`/`.`/`=`，保持线型和 marker |
| 边 | `linkStyle index/default` | ✓ | — | ✓ | ✓ | **支持**；stroke、width、label color、dasharray、linear/step curve |
| 节点 | `[]` 矩形、`()` 圆角 | ✓ | ✓ | ✓ | ✓ | **支持** |
| 节点 | `([])` 体育场、`[[]]` 子流程、`[()]` 圆柱 | ✓ | ✓ | ✓ | ✓ | **支持** |
| 节点 | `(())` 圆、`((()))` 双圆、`>..]` 非对称 | ✓ | ✓ | ✓ | ✓ | **支持** |
| 节点 | `{}` 菱形、`{{}}` 六边形 | ✓ | ✓ | ✓ | ✓ | **支持** |
| 节点 | 两向平行四边形、两向梯形 | ✓ | ✓ | ✓ | ✓ | **支持** |
| 节点 | Mermaid 11.3 `@{ shape: ... }` 48 个官方 shortName 及公开 alias | ✓ | ✓ | ✓ | ✓ | **支持**；统一归一化并共享 SVG path 几何 |
| 节点 | `@{ icon: ... }`、`@{ img: ... }` 外部资源 | 安全降级 | ✓ | 安全占位 | 安全占位 | **不适用**；产品不注册任意 icon pack、不抓取任意图片 URL，避免保存态发起外部请求；保留 label 并降级为安全矩形 |
| 样式 | `classDef`、`class`、`:::` | ✓ | — | ✓ | ✓ | **支持**；含多类名、default、fill/stroke/color/width/dash/font-size |
| 样式 | `style nodeId ...` | ✓ | — | ✓ | ✓ | **支持**；覆盖 class 样式 |
| 样式 | init `themeVariables` | ✓ | — | ✓ | ✓ | **支持**；含 `clusterBkg/clusterBorder` |
| 样式 | 任意 CSS 值 | 安全过滤 | — | 安全过滤 | 安全过滤 | **不适用**；仅接受白名单颜色、数值、dash、curve，拒绝 `url()`/`expression()`/CSS 变量注入 |
| 其他 | `%%` 独立/尾随注释 | ✓ | — | — | — | **支持**；引号内 `%%` 不误截断 |
| 其他 | 引号 label、括号字符、反斜杠转义 | ✓ | ✓ | ✓ | ✓ | **支持**；关闭括号扫描识别 quote/escape |
| 其他 | 十进制/十六进制 entity 与常用 HTML named entity | ✓ | ✓ | ✓ | ✓ | **支持** |
| 其他 | `direction TB/TD/LR/BT/RL` | ✓ | ✓ | ✓ | ✓ | **支持** |
| 交互 | `click`/`href`/JavaScript callback | 保护 | — | 禁用 | 禁用 | **不适用**；保存态按 strict security 处理，禁止文档源码注入导航或回调 |

## 自动化证据

- `packages/diagram-engine/src/__tests__/diagramEngine.test.ts`
  - 真实云原生 fixture 的 8 分区、归属、cluster 色板、三种线型与标签。
  - 递归嵌套、subgraph direction、边到分区 id。
  - 链式、多目标、两种标签、不可见边、圆/叉头、linkStyle。
  - 经典全部括号形状、Mermaid 11.3 的 48 个官方 shape shortName 与公开 alias。
  - class/style/default、注释、引号、实体与转义脏输入。
- `apps/web/src/pages/workspace/__tests__/dom/graphDiagramView.dom.test.tsx`
  - 保存态真实 fixture 渲出 8 个 `.graph-diagram-cluster`。
  - React Flow 容器宽高与 `graphToSvg` 的 `data-layout-*` 一致。
- `packages/diagram-engine/src/__tests__/fixtures-user-cloudnative.mmd`
  - 真实用户图：8 个 subgraph、35 个节点、48 条边；包含 init、5 个 classDef、实/虚/粗线与带引号标签。
