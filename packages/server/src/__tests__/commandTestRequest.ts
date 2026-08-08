import { app } from "../app";

const TEST_COMMAND_TOKEN = "server-command-route-test-token";
const TEST_COMMAND_ORIGIN = "http://127.0.0.1:5173";

/** 让既有业务路由测试显式模拟已通过桌面/网页鉴权的 command 请求。 */
export async function authenticatedCommandRequest(
  path: "/api/v1/commands",
  init: RequestInit,
): Promise<Response> {
  const previous = process.env.QINGAGENT_AUTH_TOKEN;
  process.env.QINGAGENT_AUTH_TOKEN = TEST_COMMAND_TOKEN;
  const headers = new Headers(init.headers);
  headers.set("Origin", TEST_COMMAND_ORIGIN);
  headers.set("Authorization", `Bearer ${TEST_COMMAND_TOKEN}`);
  try {
    return await app.request(path, { ...init, headers });
  } finally {
    if (previous === undefined) delete process.env.QINGAGENT_AUTH_TOKEN;
    else process.env.QINGAGENT_AUTH_TOKEN = previous;
  }
}
