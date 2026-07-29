import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { WorkingMemoryContentError } from "@qingagent/core";
import { createMemorySettingsRoutes } from "../routes/memorySettings";

function makeHarness(initial = "") {
  let content = initial;
  const writeContent = vi.fn(async (next: string) => {
    content = next.replace(/\r\n?/g, "\n").trim();
    return content;
  });
  const app = new Hono();
  app.route("/api/v1", createMemorySettingsRoutes({
    readContent: async () => content,
    writeContent,
  }));
  return {
    app,
    writeContent,
    get content() {
      return content;
    },
  };
}

function put(app: Hono, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/api/v1/settings/memory", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("长期记忆设置路由", () => {
  it("GET 区分空记忆，并返回统一上限", async () => {
    const harness = makeHarness();
    const response = await harness.app.request("/api/v1/settings/memory");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      content: "",
      exists: false,
      maxChars: 6000,
    });
  });

  it("PUT 规范化并保存用户编辑后的全文", async () => {
    const harness = makeHarness("# 用户长期记忆");
    const response = await put(harness.app, {
      content: "  # 用户长期记忆\r\n\r\n- 新内容  ",
      baseContent: "# 用户长期记忆",
    });

    expect(response.status).toBe(200);
    expect(harness.content).toBe("# 用户长期记忆\n\n- 新内容");
    expect(await response.json()).toMatchObject({
      content: "# 用户长期记忆\n\n- 新内容",
      exists: true,
    });
  });

  it("当前内容与 baseContent 不一致时返回 409 且不写入", async () => {
    const harness = makeHarness("# 已被更新");
    const response = await put(harness.app, {
      content: "# 用户编辑",
      baseContent: "# 开始编辑时",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "记忆已被更新，请刷新后再改。",
    });
    expect(harness.writeContent).not.toHaveBeenCalled();
  });

  it("超限返回 400 与清晰中文文案", async () => {
    const app = new Hono();
    app.route("/api/v1", createMemorySettingsRoutes({
      readContent: async () => "",
      writeContent: async () => {
        throw new WorkingMemoryContentError(
          "too_long",
          "长期记忆不能超过 6000 字，请先删除旧条目后再保存。",
        );
      },
    }));

    const response = await put(app, {
      content: "长".repeat(6001),
      baseContent: "",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "长期记忆不能超过 6000 字，请先删除旧条目后再保存。",
    });
  });

  it("GET 与 PUT 都拒绝不受信 Origin", async () => {
    const harness = makeHarness();
    const getResponse = await harness.app.request("/api/v1/settings/memory", {
      headers: { Origin: "https://evil.example" },
    });
    const putResponse = await put(harness.app, {
      content: "",
      baseContent: "",
    }, { Origin: "https://evil.example" });

    expect(getResponse.status).toBe(403);
    expect(putResponse.status).toBe(403);
  });
});
