#!/usr/bin/env node
// 钉钉文档 CLI(零依赖,node 18+ 全局 fetch)。
// 认证:env DINGTALK_APP_KEY + DINGTALK_APP_SECRET(企业内部应用)→ access_token。
// 子命令:
//   auth-check                              验证应用凭据(取 access_token)
//   spaces                                  列出当前应用可访问的知识库空间(wiki)
//   doc-create --space <spaceId> --title <t> [--md <markdown>]  在空间下创建文档
// 钉钉文档(钉盘/知识库)API 形态较多,本脚本覆盖最常用的 auth + 知识库创建路径;
// 不同企业的应用权限差异较大,失败时按 hint 引导用户在开放平台补权限。
// 输出统一 JSON;缺凭据/出错时 {"ok":false,...} 非零退出。

const OAPI = "https://oapi.dingtalk.com";
const API = "https://api.dingtalk.com";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}
import { writeSync } from "node:fs";
function fail(error, hint) {
  // 用 writeSync 同步落 fd1:process.exit(1) 会截断未 flush 的异步 stdout(管道捕获时丢错误 JSON,
  // 与 calc.mjs 同源教训 R3/R14 codex-4)。同步写保证退出前已 flush。
  writeSync(1, JSON.stringify({ ok: false, error, ...(hint ? { hint } : {}) }) + "\n");
  process.exit(1);
}
function ok(data) {
  writeSync(1, JSON.stringify({ ok: true, ...data }) + "\n");
}

async function getAccessToken(appKey, appSecret) {
  const url = `${OAPI}/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (json.errcode !== 0 || !json.access_token) {
    fail(
      `获取钉钉 access_token 失败: ${json.errmsg || res.status}`,
      "DINGTALK_APP_KEY / DINGTALK_APP_SECRET 无效,请在设置页重新配置(开放平台 https://open-dev.dingtalk.com 应用凭证页获取)",
    );
  }
  return json.access_token;
}

async function apiV1(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status >= 400 || json.code) {
    fail(
      `钉钉 API 错误: ${json.message || json.code || res.status}`,
      res.status === 403 ? "应用缺少知识库/文档权限,请在开放平台为应用开通对应权限" : undefined,
    );
  }
  return json;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const appKey = process.env.DINGTALK_APP_KEY;
  const appSecret = process.env.DINGTALK_APP_SECRET;

  if (!appKey || !appSecret) {
    fail(
      "缺少钉钉凭据 DINGTALK_APP_KEY / DINGTALK_APP_SECRET",
      "请让用户去设置页配置钉钉企业内部应用凭据(开放平台 https://open-dev.dingtalk.com 创建应用后获取)",
    );
  }
  const token = await getAccessToken(appKey, appSecret);

  switch (cmd) {
    case "auth-check": {
      // 绝不输出 token 任何片段(stdout 会进入工具结果与模型上下文)
      ok({ message: "钉钉应用凭据有效" });
      break;
    }
    case "spaces": {
      // 知识库空间列表(需应用开通知识库权限)
      const data = await apiV1(token, "GET", "/v1.0/wiki/workspaces?maxResults=50");
      ok({ spaces: (data.workspaces || []).map((w) => ({ id: w.workspaceId, name: w.name })) });
      break;
    }
    case "doc-create": {
      if (!args.space || !args.title) fail("doc-create 需要 --space <spaceId> 和 --title <标题>");
      const body = {
        workspaceId: String(args.space),
        name: String(args.title),
        docType: "DOC",
        ...(args.md ? { markdownContent: String(args.md) } : {}),
      };
      const data = await apiV1(token, "POST", "/v1.0/wiki/nodes", body);
      ok({ doc: { nodeId: data.node?.nodeId, title: args.title, url: data.node?.url } });
      break;
    }
    default:
      fail(`未知子命令: ${cmd ?? "(空)"}`, "可用: auth-check | spaces | doc-create");
  }
}

main().catch((e) => fail(`脚本异常: ${e?.message ?? String(e)}`));
