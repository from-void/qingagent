# AGENTS — qingagent

Conventions for any coding agent working on qingagent. **Single repo**: all
product code and quality-gate scripts live here.

## 0. Communication & output language

- Chat with the user / code comments: **Chinese (中文)**
- Variable & function names: **English**
- Commit messages / PR descriptions: **Chinese (中文)**
- This conventions file itself: **English** (cross-tool standard + more reliable
  instruction-following).

## 1. Code map & how to run

| Path | Role |
|---|---|
| `packages/core` | The Mastra brain: agents / tools / skills / browser / search / export / prompts |
| `packages/server` | Hono HTTP service (`:8080`) |
| `apps/web` | Vite + React SPA (`:5173`, proxies `/api` → `:8080`) |
| `apps/desktop` | Electron shell |
| others | `contract-ts` (hand-maintained contracts) / `ui-kit` / `pm-schema` / `diagram-engine` / `qa-cli`; `chinese-masonry` is an internal web component under `apps/web/src/system/` |

Run: `pnpm dev` (web) / `pnpm dev:server` (backend) / `pnpm dev:desktop`. See `README.md`.

## 2. Workflow (lightweight)

1. Get the project running via `README.md`.
2. Work on a **feature branch** — don't commit straight to `main`.
3. Before merging, three greens: `pnpm -r typecheck` / `pnpm -r --if-present build` / `pnpm -r --if-present test`.
4. Commits: **Conventional Commits prefix + Chinese body**, e.g. `fix(web): 修复首页白屏`.
5. Merge to `main`, and keep it green and deployable at all times.

## 3. Hard rules (MUST / MUST NOT)

### UI Iron Rules

- `#/uikit` (`UIKitPage.tsx` + `uikit.css`) is the live source of truth for UI rules.
- Use the Song-family token (`--font-zh-serif`) for product UI; keep mono only for code, paths, numbers, and keycaps.
- Default to square corners. Only pills/chips, circular avatars/dots, and 6px chat bubbles may use radius.
- Use the warm paper/gold/ink tokens from the UIKit Token section; do not invent new CSS variables for uncovered colors.
- `qa-toast` via `ToastProvider` is the only production toast channel; do not add page-local toast stacks.
- When the UIKit sheet and local code disagree, follow the sheet and document any unresolved visual exception.

**MUST**

- Contract types in `packages/contract-ts/src/` are **hand-maintained TypeScript**.
  Run `pnpm -r typecheck` after editing.
- **Framework-first (Mastra-first):** before any design or implementation, check
  the Mastra docs (`mastra.ai/docs`) for an existing capability. Use the framework's
  built-ins instead of reinventing; don't speculate a custom solution. Use the
  `/mastra` skill or WebFetch for the latest docs.
- **Model-quirks-first:** before writing code that makes an LLM produce structured
  output / tool calls / a specific format — or before choosing/switching a model —
  check the project-maintained model notes when available. Record new quirks
  **with test evidence** (don't conclude from a single observation; a small eval
  harness settles it fast). Known: deepseek-v4-flash rejects `response_format`
  json_schema — use json_object / plain prompt + self-parse instead.
- **模型结构化能力是够的，"生成结构化失败"先怀疑表示法/解析，别赖模型（高优先级铁律）:**
  deepseek-v4-flash 的**结构化输出 / 多级嵌套能力是充分的**。当"让模型产出结构化（嵌套列表 /
  工具调用 / 特定 JSON）失败 / 拍平 / 卡"时,**默认 bug 不在模型**,而在 ① 给模型的**表示法**
  (尤其"让模型吐 4-5 层深的 `children` 嵌套 JSON 括号"——模型层级语义答对,但深括号记账
  ~25% 会错一个 `{`/`]}` → 解析失败 → 合法响应被当废品 → 重试/兜底/拍平 → "挂") ② 对输出的
  **解析 / 提取**(`extractJson` 等) ③ 链路**重试逻辑**。**遇到任何模型层问题,必须像做实验一样
  先证伪/证实**:自己写干净提示词、**直连 DeepSeek API 跑 ~20 次、量化具体失败形态**(解析成功率 /
  嵌套深度 / 假信号 / 耗时,存原始响应看脏模式),**先搞清"模型到底行不行、错在哪",再动手——
  绝不靠在链路里反复改来试**。**降负通法**:让模型吐**扁平 / 低括号表示**(扁平 items +
  `depth` 整数,或类 markdown 缩进),把"搭树 / 建结构"交给**确定性代码**;模型只表达层级意图,
  结构由代码生成。教训(带实测):嵌套列表深 children JSON 15/20 解析成功(失败全是括号记账错),
  换扁平+depth → 20/20 成、全三级、还更快。
- **模型"内容对、结构/格式错"→补格式范本到它实际走的上下文,绝不造工程化引擎/工具替模型搭结构（高优先级铁律）:**
  当模型**内容对、但结构/格式不对**(嵌套拍平、用 `1.1`/`①` 文字假装层级、块形状错、把 paragraph 当 children)时,
  **默认不是模型不会,而是它所在的那个上下文缺具体格式范本**。最常见的坑:格式示例只放在**生成**侧
  prompt(writeDraft/generateDoc),却没放进**编辑**侧上下文(agent 主循环调 editDraft 用的 `system.ts`),
  于是模型编辑时不知道该吐什么 JSON 形状,只能瞎编。**正确做法:把精确格式范本(具体 JSON 示例 + 明确
  do/don't,如"children 里必须放子 list、不能放 paragraph;禁止 `1.1`/`①` 文字假装")补到模型真正操作
  的那个上下文,并核实该 code path 确实读得到**。**绝不要为"帮模型把结构搭对"去造确定性引擎/专用工具**——
  不灵活、违背"模型优先 / 框架优先(Mastra-first)"、且常常接错到模型根本不走的路径。边界:模型**已给出结构
  信号、代码机械组装**(如把模型吐的"扁平 items+depth"编译成 children 树)是 OK 的;**代码去猜 / 补模型没给的
  结构**(从无信号正文反推层级的重排引擎)才是错的。实测教训:为多级嵌套列表造了 `nestList` 确定性引擎 + 专用
  工具,绕了 R4–R9 一大圈(引擎甚至从没被 agent 走到);真正修复只是往 `system.ts` 编辑上下文加一段 children
  嵌套格式范本,一次就对,随后把整套引擎 / 工具删除。与上一条 eval-first 配套:先证明模型行,再补格式,别造工程兜底。
- **Test the dirty path（防御性函数必配对抗性输入测试）:** 解析 / 提取 / 清洗这类
  "对付不可信输入"的函数(`extractJson` / `parse*` / `sanitize*` 等),**必须**有枚举
  真实脏形态的单测——对 LLM 输出尤其要测:JSON + 尾随收尾散文、` ```json ` fence、
  前导话 + JSON、正文字符串里含 `]`/`}`、转义引号、截断。配套四条:
  ① **评测 / 测试一律 import 项目真实函数**,绝不在脚本里自己重写关键逻辑(否则会绕过
  真 bug、给"模型没问题"之类假信号);② 线上真实失败样本(raw)固化成 fixture 进回归;
  ③ **每修一个 bug 必带一条能复现它的回归测试**。历史教训:extractJson 曾把模型 JSON
  后的收尾散文一起 parse,一个简单 bug 因零单测埋到线上稳定失败才发现。
- Capability skill scripts under `packages/core/skills/**/scripts/` must be
  JavaScript (`.mjs` / `.js`) and in-process-first: prefer Mastra/in-process
  tools such as `run_js` for deterministic computation. If a script is truly
  needed, keep it zero-runtime-dependency, use only `node:` builtins or relative
  bundled files, and expose an argv/stdin interface. No `.py` scripts or bare
  third-party imports unless the bundling rule and guard are explicitly updated.
- **Agent-tool 心跳（耗时工具防 idle 看门狗误杀）:** agent 主流有个空闲看门狗
  `withIdleTimeout`（`packages/core/src/bridge/wireFrameEmitter.ts`，默认 90s）——工具
  `execute()` 期间若 agent 主流连续静默超过该时长就 **abort 整轮、产物丢失**（线上 session
  b9186915:generateImage 生成 SVG 60s 期间静默被掐、配图没插入）。**新增或修改 agent 工具时,
  只要 execute 内部可能长时间静默**（内部再调 LLM / 浏览器自动化 / 子进程沙箱 / 大文件解析 /
  慢网络抓取等,工具内部的流不会冒泡到 agent 主流),**必须**用 `startToolHeartbeat(context)`
  （`packages/core/src/tools/toolHeartbeat.ts`）包住执行体:
  `const stop = startToolHeartbeat(context, { tool: "<name>" }); try { …耗时… } finally { stop(); }`
  ——它周期性往 `context.writer` 注入瞬时 chunk 清零看门狗(失败静默,不影响主链)。心跳是
  **主防线**,不要靠调大 idle 兜底。已接入:generateImage / scrapeWithBrowser / parseFile /
  askUser（askMore 走 SSE 路由不经看门狗,不接;runJs/runPython 硬超时<15s,不需要）。另:
  tool-call 参数生成期已有"占位卡"机制（主循环消费 tool-call-input-streaming-start/delta/end）,
  改主循环 tool-call 分支时勿破坏其去重。
- **超时/慢 → 先定位根因，绝不反射性砍 max_tokens / 砍输出预算（基调原则）:** 遇到工具或
  生成"慢/超时/卡住",**第一反应不能是"调小 max_tokens / 缩输出上限"**。砍输出预算只会把产物
  **截断**——内容写一半、列表/SVG/JSON 不完整,等于把功能改没了,提速没有任何意义。**必须先用
  日志(observability span / log-console)量化"慢在哪一层"**,再从真正的慢因提速:无谓重试(agent
  层盲目重调)、错误的验收门触发多轮重跑(如字数门把"≥N"做成硬区间逼出第二轮赛马)、并发不取消
  (`Promise.all` 等所有 lane 不在拿到合格结果后 abort 其它)、模型在做无谓 reasoning/thinking、
  缺流式进度让人干等、单次硬超时设得过大叠加重试。只有在**确认产物本就不需要那么多 token**
  (例如一张简洁 SVG 示意图根本用不到 16k token)时,才可谨慎收 token,且**必须保证产物完整不被
  截断**(配元素/复杂度约束 + 完整性校验,而不是直接砍上限赌它够)。教训:generateImage 一回合
  280s/4 次各 66s 全 abort,真因是 maxTokens=16384 鼓励超复杂 SVG + agent 盲目重调 + 无可见进度,
  不是"token 不够"。同理首稿慢的主因是错误字数门触发第二轮赛马,不是模型本身慢。
- On `main`, the three greens and CI MUST stay green.

**MUST NOT**

- MUST NOT automatically change production secrets, deploy targets, IAM, or
  CI/workflow permissions. These need explicit human authorization.
- MUST NOT run two machines on the same branch concurrently. Commit and push
  first; on the other side clear any stale state, then `pull`.
