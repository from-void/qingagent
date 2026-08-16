# M3 Attach 自愈交付报告

## 交付范围

- 分支：`feat/attach-selfheal`
- 任务：`#67 attach 连接对引擎实例重启的自愈`
- 约束遵守：未启动 dev server，未访问 `127.0.0.1:8080/3080`，未读写真实 `~/.qingagent`，未修改其他 worktree 或 `main`，未 push。
- 提交状态：当前沙箱将共享 Git 元数据目录 `/home/jimmy/proj/qingagent/main/.git/worktrees/m3heal` 设为只读，`git add` 创建 `index.lock` 时失败，因此改动已落盘但无法在本环境内生成提交。

## 改动点

### 1. 重认证阶段的实例重启自愈

- `handshakeAttachInstance` 为 `AUTH_FAILED` 保留 HTTP `status`，区分 401 与 403。
- 数据面 401 的既有分支保持不变：只有 `ATTACH_SESSION_EXPIRED` 会触发重认证，无 code 或未知 code 继续按原逻辑透传。
- 重认证握手返回 401 时，连接保持在 `reauthenticating`，复用 `#recoveryFlight` 单飞执行 rediscover 与重新握手。
- rediscover 返回 `STARTING_LEASE` 或空结果时按 1s、2s、4s、8s 上限指数退避；总恢复预算约 30s，耗尽后才进入 `dead`。
- rediscover 采用滚动窗口限频：60s 内最多 2 次，避免引擎长时间不可用时周期性拉起发现子进程。
- rediscover 得到原 `instanceId` 且重新握手仍为 401 时直接进入 `dead`；403 直接进入 `dead`，不消耗 rediscover 预算。
- 恢复成功后更新实例、session 与过期时间，回到 `attached`，并递增快照 `generation` 作为一次真实恢复事件。
- `attachDiscoveryWorker` 的 `STARTING_LEASE` 不确定结果已从桌面主进程透传给连接状态机。

### 2. 恢复后唤醒文档重存

- 工作区文档编辑器除浏览器 `online` 外，同时订阅现有桌面连接快照事件。
- 仅在 attach 模式发生 `reauthenticating -> attached` 时，重新提交 `failedTransientDocWriteRef` 中保留的写入。
- 普通续租产生的重复 `attached` 快照不会误触发重存；重试继续使用原写入的 expected version、base hash 与文档内容。

### 3. Skills attach 白名单同步

- 契约层 `ATTACH_DATA_ROUTE_TEMPLATES` 新增 `GET /api/v1/skills`。
- 服务端 `ATTACH_ROUTE_POLICY` 同步新增同一路由。
- 更新独立期望集合，继续由 `attachPolicy.contract.test.ts` 校验两侧奇偶一致。
- 新增真实 attach 握手后访问 skills 路由的 200 回归测试；测试使用 `/tmp` 下临时 HOME 与 skills 目录。

## 状态机行为变化

| 场景 | 修改前 | 修改后 | 最终状态 |
|---|---|---|---|
| 数据面 401，code 为 `ATTACH_SESSION_EXPIRED`，旧实例重握手成功 | 重认证成功 | 行为保持 | `attached` |
| 数据面 401，code 为空或未知 | 不触发重认证，响应透传 | 行为保持 | 原状态 |
| 重认证握手返回 401，rediscover 得到新实例且握手成功 | 立即 `dead` | 在 `reauthenticating` 内单飞 rediscover、重握手，并发布恢复快照 | `attached`，`generation + 1` |
| rediscover 返回 `STARTING_LEASE` 或空 | 无恢复路径 | 指数退避，受约 30s 总预算和 60s/2 次限频约束 | 成功则 `attached`，耗尽则 `dead` |
| rediscover 得到原 `instanceId`，重握手仍返回 401 | 立即 `dead` | 明确终止恢复，不继续消耗预算 | `dead` |
| 重认证握手返回 403 | 立即 `dead` | 保留 403 语义，直接终止且不 rediscover | `dead` |
| attach 自愈成功时存在失败的瞬时文档写入 | 只等待浏览器 `online`，可能长期不重存 | 连接恢复事件立即唤醒原写入重试 | `attached` 后重存 |
| `revalidating` 探活流程 | 既有探活语义 | 未复用、未改变 | 行为保持 |

## 测试证据

所有命令均使用 `/tmp` 临时 HOME、临时 `QINGAGENT_USER_SKILLS_DIR`；未使用真实用户目录。

### 通过

- `pnpm -r typecheck`：通过，仓库 11 个参与包全部通过。
- Desktop 自愈定向回归：7/7 通过，覆盖：
  - 旧 session 401 `ATTACH_SESSION_EXPIRED` → 旧实例握手 401 → 新实例发现/握手成功 → `attached` 与恢复事件；
  - `STARTING_LEASE` 退避后成功；
  - 空发现结果预算耗尽进入 `dead`；
  - 403 直接进入 `dead` 且不 rediscover；
  - 数据面无 code 的 401 不触发自愈；
  - 原 `instanceId` 仍为 401 直接进入 `dead`；
  - 握手错误保留 401/403 status。
- Web 工作区完整测试文件：157/157 通过；其中新增恢复后失败写入重存回归 1/1 通过。
- Server 全量测试：106 个测试文件、869 个测试全部通过。
- Contract 全量测试：16 个测试文件、234 个测试全部通过；包含白名单奇偶校验。
- Server attach 定向测试：2 个文件、19 个测试全部通过；包含 skills attach 场景 403 → 握手 → 200。
- Desktop 构建在仓库已有 `QINGAGENT_BUNDLE_LARK_CLI=0` 模式下通过，主进程、preload、renderer 注入、Pyodide 与 QA CLI 均完成构建。
- `git diff --check`：通过。

### 当前执行环境限制

- Desktop 全量测试共 50 个文件，其中 44 个文件通过；其余 6 个文件需要当前沙箱禁止的系统能力：
  - `backendConnection.test.ts` 与 `desktopAppProxyFetch.test.ts` 的既有本地 HTTP fixture 在绑定 `127.0.0.1` 随机端口时收到 `listen EPERM`。本次新增测试使用纯内存 fetch seam，7/7 通过。
  - 3 个 Electron 测试文件因 Chromium sandbox host 的 `Operation not permitted` 退出。
  - `attachDiscovery.test.ts` 中 2 个 worker-spawn 用例在沙箱内返回 `ENUM_FAILED`；其余 7 个通过。
- 默认仓库 build 进行到 Desktop 的既有 Lark CLI stage 时，需要安装未缓存的 `@larksuite/cli@1.0.53`；当前环境禁网且 npm cache 无该包，报 `ENOTCACHED`。使用仓库已有的 slim 构建开关 `QINGAGENT_BUNDLE_LARK_CLI=0` 后 Desktop 构建通过。

上述限制均发生在本次代码路径之外；相关定向回归、类型检查、Server/Contract 全量测试和可离线完成的 Desktop 构建均已通过。
