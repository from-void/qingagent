#!/usr/bin/env node

// 真实网络 usage 事件探针。只输出 token 摘要，不输出正文、请求头或密钥。
// OpenAI:
//   node --env-file=../server/.env scripts/verify-stream-usage.mjs openai
// Anthropic/GLM:
//   QINGAGENT_MODEL_PROTOCOL=anthropic QINGAGENT_DEEPSEEK_BASE_URL=... \
//   QINGAGENT_MODEL_FLASH=... DEEPSEEK_API_KEY=... node scripts/verify-stream-usage.mjs anthropic

const protocol = process.argv[2] ?? process.env.QINGAGENT_MODEL_PROTOCOL ?? "openai";
const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const baseUrl = (process.env.QINGAGENT_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1")
  .replace(/\/+$/, "");
const model = process.env.QINGAGENT_MODEL_FLASH ?? "deepseek-v4-flash";

if (!apiKey) {
  console.error("缺少 DEEPSEEK_API_KEY");
  process.exit(2);
}
if (protocol !== "openai" && protocol !== "anthropic") {
  console.error("协议必须是 openai 或 anthropic");
  process.exit(2);
}

const url = protocol === "anthropic"
  ? `${/\/v\d+$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`}/messages`
  : `${baseUrl}/chat/completions`;
const headers = protocol === "anthropic"
  ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }
  : { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
const body = protocol === "anthropic"
  ? {
      model,
      max_tokens: 16,
      system: "只做连通性测试。",
      messages: [{ role: "user", content: "回复 OK" }],
      stream: true,
    }
  : {
      model,
      messages: [{ role: "user", content: "回复 OK" }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 16,
    };

const response = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) {
  console.error(JSON.stringify({ ok: false, protocol, status: response.status }));
  process.exit(1);
}

let usage = null;
let eventTypes = [];
const text = await response.text();
for (const line of text.split(/\r?\n/)) {
  if (!line.startsWith("data:")) continue;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") continue;
  try {
    const json = JSON.parse(data);
    if (typeof json.type === "string") eventTypes.push(json.type);
    if (protocol === "anthropic") {
      if (json.type === "message_start" && json.message?.usage) {
        usage = { ...(usage ?? {}), ...json.message.usage };
      }
      if (json.type === "message_delta" && json.usage) {
        usage = { ...(usage ?? {}), ...json.usage };
      }
    } else if (json.usage) {
      usage = json.usage;
    }
  } catch {
    // 探针只关心 usage，忽略网关插入的非 JSON data 行。
  }
}

const result = {
  ok: Boolean(usage),
  protocol,
  model,
  usage,
  eventTypes: [...new Set(eventTypes)],
};
console.log(JSON.stringify(result));
if (!usage) process.exit(1);
