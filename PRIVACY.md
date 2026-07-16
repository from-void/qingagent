# 隐私说明

青简桌面端的遥测用于了解产品是否能正常启动、核心功能是否被使用、错误是否集中出现。源码构建和本地构建默认不启用遥测；只有官方发布包在构建期注入端点后才会启用。遥测失败不会影响应用启动或使用。

## 端点与启用规则

- 源码内不包含默认上报端点。本地构建未设置 `QINGAGENT_TELEMETRY_ENDPOINT` 时,遥测模块整体静默不启用。
- 官方发布包会在构建期注入端点,客户端启动时再读取 `update-policy.json` 的 `telemetryEndpoint` 字段用于热切。只有带构建期注入端点的官方包才会应用 policy 覆盖。
- 当前 policy 样例端点为 `https://t.qingagent.com/api/send`。policy 不可达时回退构建期注入端点;两者都没有时不上报。
- 设置 `QINGAGENT_TELEMETRY_DISABLED=1` 会关闭任何来源的遥测端点。桌面端会读取用户数据目录下的 `.env`,也可在启动环境变量中设置。

## 第三方字体请求

- Web 启动页会通过 Google Fonts 请求 Noto Sans SC、Noto Serif SC 和 JetBrains Mono；桌面端打开启动页时也会发生同样的请求。
- 以 HTML 格式导出文档时，导出的文件包含同一 Google Fonts 样式表链接；用户在浏览器中打开该文件时会向 Google Fonts 发起请求。PDF 导出不发起此类请求。
- 这些请求由浏览器直接发送给 Google Fonts。Google 可从请求中获得网络 IP 地址、User-Agent 等浏览器自动携带的信息；qingagent 不会在该请求中附加文档正文、聊天输入、附件或 API Key。
- 在断网或需要避免此类第三方请求的环境中，可不打开启动页、避免在浏览器中打开 HTML 导出文件，或在部署/构建时将上述字体改为本地自托管。当前仓库不包含这些 Google Fonts 字体文件。

## 共同字段

每条事件会包含 Umami 需要的基础字段:

- `website`:站点 ID。
- `hostname`:固定为 `desktop`。
- `language`:应用 locale。
- `url`:桌面端固定为 `/app`,渲染端 pageview 为 hash 路由路径且去掉 query。
- `device_id`:本机随机 UUID,保存在用户数据目录 `.qing-telemetry-id`;不来自硬件指纹。
- `appVersion`、`platform`、`arch`、`locale`、`electronVersion`、`nodeVersion`:应用与运行环境版本信息。
- 上报请求的 User-Agent 为 Chrome/Electron 风格 UA。服务端也会自然看到网络请求的 IP 地址。

## 事件字段

当前桌面端采集以下事件,不采集文档正文、聊天输入、附件内容或 API Key 明文:

- `app_opened`: `first_run`、`has_key`、`has_sent_message`、`has_applied`、`has_exported`、`age_days`。
- `app_closed`: `session_ms`、`duration_bucket`。
- `message_sent`:无额外业务字段。
- `patch_applied`: `kind`。
- `export_done`: `format`。
- `key_configured`:无额外业务字段,仅首次配置时上报。
- `tool_used`: `tool`,截断到 50 字符。
- `settings_shown`:无额外业务字段。
- `app_error`: `errorName`、脱敏并截断的 `errorMessage`,以及调用方传入的错误类别字段,例如 `errorKind`、`errorOrigin`。
- `app_error_renderer`: `errorName`、脱敏并截断的 `errorMessage`。
- pageview:无 `name` 的 Umami pageview,仅含去 query 的 hash 路由路径。

错误消息会经过路径、密钥、Bearer token、JWT 等脱敏规则处理后再截断上报。

## 关闭方式

在启动环境或用户数据目录 `.env` 中设置:

```bash
QINGAGENT_TELEMETRY_DISABLED=1
```

该开关优先级最高,会覆盖 policy 端点和构建期注入端点。
