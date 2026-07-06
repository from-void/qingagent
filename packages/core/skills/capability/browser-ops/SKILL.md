---
name: browser-ops
label: 浏览器操作
summary: 打开网页、点击、登录和处理交互
icon: browser
description: 交互式浏览器操作能力。用于目标内容必须通过打开页面、点击展开、翻页、输入、登录、处理付费墙或其它页面交互才能看到的场景。普通 URL 内容获取优先使用 fetchArticle；fetchArticle 会在静态内容不足时自动渲染重试。
user-invocable: true
placeholder: 粘贴需要操作的链接
tools: [browser_*]
metadata:
  category: capability
  emits: material
---

# 浏览器操作

你的任务：在需要真实页面交互时使用 `browser_*` 工具打开页面、观察当前可见内容，并按用户目标完成点击、输入、翻页、登录或展开。

## 什么时候使用

- 页面内容需要登录、付费权限、点击展开、翻页、搜索框输入或其它交互后才能看到。
- 用户明确要求你在网页上执行操作，例如打开页面查看状态、点击某个按钮、填写表单、展开隐藏内容。
- `fetchArticle` 已无法满足，因为问题不是普通内容获取，而是必须操作页面。

普通公开文章、博客、新闻、公众号等链接，先用 `fetchArticle`。它会在静态结果不足时自动使用无头浏览器渲染重试；你不需要手动做浏览器降级。

## 基本流程

1. `browser_goto` 打开页面。
2. `browser_snapshot` 读取可访问性快照，用 `@eN` 引用元素。
3. 按需使用 `browser_click` / `browser_type` / `browser_press` 完成交互。
4. 再次 `browser_snapshot` 确认页面状态。
5. 若用户目标是把交互后可见内容作为素材，读到正文后进「存储原文」。

## 登录流程（human-in-the-loop）

- 手机号 + 短信验证码：登录页选「验证码登录 / 手机号登录」→ 用 `askUser` 索取手机号
  → `browser_type` 填入 → `browser_click`「获取验证码 / 发送验证码」→ 用 `askUser` 索取刚收到的短信验证码
  → `browser_type` 填入验证码 → `browser_click` 登录/提交 → `browser_snapshot` 确认已登录。
- 账号密码登录：用 `askUser` 索取账号与密码 → `browser_type` 分别填入 → 提交。
- 浏览器会话在 `askUser` 等待期间保持存活，拿到验证码后继续在原页面操作即可。
  登录成功后登录态自动持久化，后续访问同站通常无需重复登录。

## 禁止

- 不尝试破解图形验证码、滑块或风控；遇到这类限制，或必须扫码登录时，如实告知用户需要人工处理。
- 若 `browser_*` 工具不可用，告知用户当前环境无法执行页面交互，请用户提供可访问内容。
- 不抓取不属于用户、明显需要他人授权的私有内容。
- 不臆造内容：看不到就如实说明，请用户粘贴或授权访问。
- 不要把可见内容直接写进文档；先 `storeMaterial`，由后续写作引用。

## 存储原文

调用 `storeMaterial`，传**完整原文**（`text` 全文不截断）、`title`、`sourceUrl`、可用的 `materialId`。
存后简短告知已收入素材，报告标题与字数。
