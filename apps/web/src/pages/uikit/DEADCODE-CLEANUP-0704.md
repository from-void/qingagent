# UIKit 更新配套死代码盘点（2026-07-04）

配合 `#/uikit` 全面更新（补审核态回流 / 图表块 / Toast，去掉画廊 demo 表示）做的死代码核查。

**核心结论:本轮改动后,revampUi 里的 demo 组件/类几乎都 _不_ 可安全删除**——因为除了
`#/uikit`,还有 **`#/spec`(SpecDemoPage)** 和 **`#/gallery`(GalleryPage)** 两个 dev-only 页在并行
消费同一套 `revampUi` 导出。主会话审计只点了 `#/uikit` 一个消费者,漏了 `#/spec` 这个「最终设计
demo」页仍在用 `UPatch / UCitation / USource`。删任何一个前都 grep 过全仓,证据附下。

## 一、本轮实际改了什么（`#/uikit`，未 commit）

- `UIKitPage.tsx`
  - 移除对 `UPatch / UCitation / USource`(revampUi 的 demo 表示)的引用;
  - 新增 3 节:**15 图表块(DiagramRenderer 真渲染)/ 17 轻提示 Toast / 18 审核态回流(ReviewOutcomeCard + patchSummary)**;
  - 第 19 节「现役对话组件」的「其它元素」子组:来源卡改用生产 `BrowserViewPart`,引用改用生产
    `citation` part(经 `ChatMessageList` 真实分发,渲染成 `.wf-chip.mono`);
  - 新增 `Live` 小包装:把 `MessagePart` 交给生产 `ChatMessageList` 真实分发路径(patchSummary /
    citation 等无独立导出的内联态,靠它单一真源渲染)。
- `uikitMocks.ts`:新增 `reviewMixed / reviewAllRejected / reviewAllAccepted`(ReviewOutcome)、
  `sourceImageWithThumb / sourceImageNoThumb`(ImagePart)、`diagramFlowchart / diagramSequence`
  (Mermaid 源);移除对 `TINY_SVG` 的对外直用(仍在文件内部被 mock 复用)。
- `uikit.css`:新增两段作用域样式——内嵌 `Live` 的 `.ws-chat` 去撑高/滚动/内边距;
  `.uk-diagram-sample` 给 React Flow 画布显式高度(镜像 gallery 的 `.gx-diagram-sample`)。
- 新增 `import "../new-session/new-session-qing.css"`(为 Toast 节的 `.ccx-toast` 供样式;该 CSS 仅
  `.ccx-*` 作用域 + `:root` 里 `--ccx-*` 命名空间变量,无裸元素选择器,已核实不污染本页其它节)。

**注意:以上都没有删除任何 `revampUi` 导出或 `.u-*` 类。** `#/uikit` 只是不再 _引用_ 它们。

## 二、逐项「是否死代码」判定（grep 全仓证据）

| 符号 / 类 | 原用途 | 现在是否死 | 证据 |
|---|---|---|---|
| `UPatch`(`.u-bar`) | 画廊「已修改 N 处」假条 | **非死** | `SpecDemoPage.tsx:147` 仍用;`revampUi` 的 `URevampPart` patchSummary 分支也调它(→ `#/gallery`) |
| `UCitation`(`.u-cite`) | 画廊引用 demo | **非死** | `SpecDemoPage.tsx:150` 仍用 |
| `USource`(`.u-source*`) | 画廊来源卡 demo | **非死** | `SpecDemoPage.tsx:148-149` 仍用 |
| `.u-bar`(thinking「已深度思考」) | `URevampPart` thinking 分支 | **非死** | `revampUi.tsx` thinking case 内联用;`#/gallery` 的 `URevampPart` 走它 |
| `UReadImage` 从 revampUi 的**再导出** | `revampUi.tsx:32` `export { …UReadImage… }` | **死(仅此再导出)** | 全仓无人 `import { UReadImage } from ".../revampUi"`(只有 `chatUnified.tsx` 定义 + revampUi 再导出)。**未删**:属共享 `revampUi`,删它零收益且触碰 gallery/spec 共用文件,留给主会话一并处理 |
| `ccx-toast`(`.ccx-toast`) | 新建页回填提示 | **非死** | `NewSessionPage.tsx:958` 在用(现役新建页) |
| `DocVerToast`(`.doc-ver-toast`) | 文档版本 toast | **非死** | `WorkspacePage.tsx` 在用 |
| `.wf-toast` / `ToastProvider` | 全局 toast | **非死** | 全站 100+ 处 `useToast().show()` |

**净结论:除 `UReadImage` 一处无用再导出(未删,见上)外,本轮没有可安全删除的死代码。**

## 三、留给主会话拍板的疑点（有风险,未自作主张）

1. **`#/spec`(SpecDemoPage)与 `#/uikit` 现在高度重复。** 两者都是 dev-only「对话工具元素最终样式」
   基准页;`#/uikit` 已升级为跟生产同步的单一真源,而 `#/spec` 仍停在 `UPatch/UCitation/USource`
   这套 **画廊 demo 表示**(与现役不符)。
   - 若**退役 `#/spec`**(删页 + Router 注册 + `SpecDemoPage.tsx` + `specDemo.css`),则
     `UPatch/UCitation/USource` 只剩 `revampUi` 自身 + `#/gallery` 的 `URevampPart` 消费;其中
     `UCitation/USource` 会**彻底变死可删**(URevampPart 的 citation 走 `OldPart`、image 走
     `BrowserViewPart`,都不碰这俩),`.u-cite/.u-source*` 类随之可删。`UPatch/.u-bar` 仍被
     `URevampPart`(gallery)用,不可删。
   - 若**保留并同步 `#/spec`**(把它也切到生产组件),同样能让上述几项变死。
   - **任一动作都会改到 `revampUi` / `#/gallery` 共用面,须主会话确认后专项做**,本轮未碰。

2. **三套 toast 是否归一。** `.wf-toast`(全局)/ `.doc-ver-toast`(工作区版本)/ `.ccx-toast`(新建页)
   是三套独立实现,视觉各异(暗底白 / 绿底 / 暗底朱砂描边)。`.ccx-toast` 与 `.wf-toast` 定位重叠
   (都是浮层轻提示),**是合并候选**,但都非死代码——合并属产品设计决策,本轮只在 kit 里如实并列陈列
   并加了「是否归一由主会话定夺」的注记,未动任何 toast 实现。

3. **`#/gallery` 的 `URevampPart` patchSummary→`UPatch`、thinking→`.u-bar` 是画廊「改造版/提案」列的
   demo**(chat-polish「现状 vs 提案」对比用),与生产 `ReviewOutcomeCard`/patchSummary 内联条不是一回事。
   要不要把画廊这两处也对齐生产,属 gallery 自身范畴,本轮未动。

## 四、护栏核对

- `#/uikit` / `#/gallery` / `#/spec` 三页改后均正常渲染(真机截图核对:h1 均在、bodyLen 正常)。
- 三绿:`pnpm --filter @qingagent/web typecheck` 通过;默认套 84 files/799 tests 全绿;
  DOM 套 36 files/274 tests 全绿(`--pool=forks --poolOptions.forks.singleFork`)。
- 未 commit,改动全留工作树。
