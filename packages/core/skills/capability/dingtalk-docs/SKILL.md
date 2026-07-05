---
name: dingtalk-docs
description: 钉钉(dingtalk)文档操作——把写好的文档发布到钉钉知识库,或验证钉钉应用凭据。当用户要"发到钉钉""创建钉钉文档""同步到钉钉知识库"时使用。需要用户在设置页配置钉钉企业内部应用凭据(AppKey/AppSecret)。
user-invocable: false
metadata:
  category: capability
  platform: dingtalk
  requiredEnv: DINGTALK_APP_KEY,DINGTALK_APP_SECRET
---

# 钉钉文档操作

你的任务：把文档发布到钉钉知识库。通过 `mastra_workspace_execute_command` 运行
本技能的 `scripts/dingtalk.mjs`(用本技能注入的绝对路径)。认证靠环境变量
`DINGTALK_APP_KEY`/`DINGTALK_APP_SECRET`(系统已注入,脚本内自动换取 access_token),
你**不需要也不要**在命令里写凭据。

## 标准流程

1. **验证凭据**：
   ```bash
   node <技能目录>/scripts/dingtalk.mjs auth-check    # 失败会提示去设置页配置
   ```
2. **找知识库空间**：
   ```bash
   node <技能目录>/scripts/dingtalk.mjs spaces         # 列出可写知识库,拿 spaceId
   ```
3. **创建文档**：
   ```bash
   node <技能目录>/scripts/dingtalk.mjs doc-create --space <spaceId> --title "标题" --md "## 正文\n..."
   ```

## 规则

1. 所有命令输出 JSON,成功 `{"ok":true,...}` 失败 `{"ok":false,"error":...,"hint":...}`。
2. 返回 `缺少钉钉凭据` 时**不要重试**,明确告诉用户去设置页配置钉钉企业内部应用的 AppKey/AppSecret,申请地址 https://open-dev.dingtalk.com。
3. 返回缺权限(hint 提到知识库/文档权限)时,告诉用户去开放平台给应用开通知识库读写权限。
4. 钉钉不同企业的应用权限差异较大,若 spaces 返回空或报权限错,如实告知用户需要管理员在开放平台为应用授权。
5. 绝不在命令里硬写凭据。
