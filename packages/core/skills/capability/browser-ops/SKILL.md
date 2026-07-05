---
name: browser-ops
label: 抓网页
summary: 抓取网页正文存为素材
icon: browser
description: 浏览器操作——获取网页正文并存为写作素材。当用户给出 URL（文章、公众号、小红书、博客、新闻、文档页等），或目标内容需要渲染 JS、登录、过付费墙、交互（点击展开/翻页/输入）才能看到时使用。三种手段由轻到重：静态抓取（fetchArticle）→ 无头浏览器渲染（scrapeWithBrowser）→ 浏览器自主操作（browser_*，含验证码登录）。抓到后必须用 storeMaterial 存入完整原文。
user-invocable: true
placeholder: 粘贴链接
tools: [fetchArticle, scrapeWithBrowser, browser_*]
metadata:
  category: capability
  emits: material
---

# 浏览器操作

你的任务：把网页的**完整正文**取下来，作为写作素材存储。
不要做总结、不要截断、不要改写——保存原文。

按需**由轻到重逐级升级**，不要一上来就用重工具。

## 工具可用性（先读这条）

下面三级用到的工具不一定都常驻——**只在"当前可用工具列表里确实存在该工具"时才调用它**。
某一级工具不存在，就跳到下一级，或如实告知用户该来源的限制并请其手动粘贴正文。**绝不臆造调用。**

- `fetchArticle`：始终可用。
- `scrapeWithBrowser`：仅在本技能（浏览器操作）启用时可用。
- `browser_*`（`browser_goto` / `browser_snapshot` / …）：仅在环境开启浏览器自主操作时可用。

## 第 1 级 — 快速静态抓取（默认，永远先试）

调用 `fetchArticle`，参数 `{ url }`。基于 HTTP fetch + cheerio 的静态抓取，
快、省、无浏览器开销，对多数文章站（含公众号、多数博客/新闻）足够。

### 降级判定
满足**任一**条件 ⇒ 快路径失败，进第 2 级：
- `needsBrowserFallback === true`（优先以此为准），或 `wordCount === 0`，或
  `title === "抓取失败"`，或 `text` 以 `"[Error]"` 开头，或正文明显过短/不完整。

否则正文充足 → 直接进「存储」。**不要为已成功的快速抓取再调浏览器。**

## 第 2 级 — 无头浏览器渲染（快路径失败时）

调用 `scrapeWithBrowser`，参数 `{ url }`（可选 `waitForSelector`、`timeoutMs`）。无头浏览器渲染 JS，
适合前端动态渲染的页面（部分 SPA 博客、知乎专栏等）。
返回比 `fetchArticle` 多了 `ok` / `error` 两个字段，核心字段（`title`/`text`/`wordCount`）一致，**务必先看 `ok`**：

- `ok === true` → 用 `text` 进「存储」。
- `ok === false`（`text` 以 `[Error]` 开头，通常是登录墙 / 反爬 / 渲染后仍取不到正文）：
  **不要把这段 [Error] 文本当正文存进素材**，转而升级到第 3 级，或如实告知用户。
- 每个 URL 浏览器降级**最多调用一次**，不要重试。

## 第 3 级 — 浏览器自主操作（需登录 / 付费墙 / 交互时，最重）

触发条件：`scrapeWithBrowser` 返回 `ok === false`（login wall / anti-bot），或判断目标内容
**必须登录 / 过付费墙 / 需交互（点击展开、翻页、输入）**才能看到。

若 `browser_*` 工具集可用：
1. `browser_goto` 打开页面 → `browser_snapshot` 读可访问性快照（用 `@eN` 引用元素）。
2. 按需 `browser_click` / `browser_type` / `browser_press` 完成登录或展开内容。
3. 再 `browser_snapshot` 确认 → 读到正文后进「存储」。

### 登录流程（human-in-the-loop，无头也能完成）
- **手机号 + 短信验证码（飞书等首选）**：登录页选「验证码登录 / 手机号登录」→ 用 `askUser` 索取手机号
  → `browser_type` 填入 → `browser_click`「获取验证码 / 发送验证码」→ **用 `askUser` 索取刚收到的短信验证码**
  （说明你已点了获取验证码、请用户把收到的 6 位码发你）→ `browser_type` 填入验证码 → `browser_click` 登录/提交
  → `browser_snapshot` 确认已登录。
- **账号密码登录**：用 `askUser` 索取账号与密码 → `browser_type` 分别填入 → 提交。
- 浏览器会话在 `askUser` 等待期间保持存活（同一页面），拿到验证码后继续在原页面操作即可。
  登录成功后登录态自动持久化（存进 agent 浏览器），后续抓同站无需重复登录。

### 禁止
- **不要尝试破解图形验证码 / 滑块 / 风控**；遇这类、或必须扫码登录（无头环境无法扫码）时，
  才如实告知用户需人工处理（例如先在有头浏览器完成一次登录，之后复用登录态）。
  短信验证码不属于此列——按上面的 `askUser` 流程走。
- 若 `browser_*` 工具不可用（环境未启用浏览器自主操作），告知用户该来源需登录、建议手动复制粘贴正文。

## 存储原文（无论哪一级成功都做）

调用 `storeMaterial`，传**完整原文**（`text` 全文不截断）、`title`、`sourceUrl`、可用的 `materialId`。
存后简短告知已收入素材，报告标题与字数。

## 多个 URL
逐个按上面的分级流程处理；一个失败不影响其它。最后汇总：成功 N 篇、失败 M 篇及原因。

## 边界与禁止
- 只操作 http/https 公开页面；底层 SSRF 防护拒内网/私有地址，遇拒绝直接告知不可抓取，勿绕过。
- 不抓取不属于用户、明显需要他人授权的私有内容。
- 不臆造内容：取不到就如实说，请用户粘贴。
- 不要把抓取结果直接写进文档；先 `storeMaterial`，由后续写作引用。
