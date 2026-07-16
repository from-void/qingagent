import { describe, expect, it } from "vitest";
import { evaluateCommandPolicy } from "../workspace/commandPolicy.js";
import { sessionWorkspaceDir, buildSandboxEnv } from "../workspace/sessionWorkspace.js";

const workspaceCwd = sessionWorkspaceDir("audit-test");

function decision(command: string) {
  return evaluateCommandPolicy(command, { workspaceCwd });
}

describe("沙箱安全审计 四维度对抗输入验证", () => {
  describe("维度1-3 迁移：env/组合/脚本路径从 deny 降为 OS 边界，凭据保持极窄", () => {
    it.each([
      'LARK_CLI_NO_PROXY=".feishu.cn()" lark-cli auth status',
      "LARK_CLI_NO_PROXY=../../etc/x lark-cli auth status",
      "FEISHU_APP_SECRET=x lark-cli auth status",
      "HTTPS_PROXY=http://evil lark-cli auth status",
      "LARK_CLI_NO_PROXY=1 NO_PROXY=.feishu.cn lark-cli auth status",
      "LARK_CLI_NO_PROXY=1 HTTPS_PROXY=http://evil lark-cli x",
      "LARK_CLI_NO_PROXY=1 node /tmp/x.js",
    ])("旧 env/路径 deny 用例现 allow 且不获得 consumer：%s", (command) => {
      expect(decision(command)).toEqual({ action: "allow" });
    });

    it("组合尾段按真实副作用分类，而不是因组合语法 deny", () => {
      expect(decision("LARK_CLI_NO_PROXY=1 lark-cli auth status 2>&1 || true").action).toBe("allow");
      expect(decision("LARK_CLI_NO_PROXY=1 lark-cli auth status && rm -rf /").action).toBe("confirm");
      expect(decision("LARK_CLI_NO_PROXY=1 lark-cli auth status && lark-cli auth login").action).toBe("deny");
    });

    it("env/wrapper 不能让受信 node 继承凭据标记", () => {
      const calc = "node /tmp/untrusted.mjs";
      expect(decision(`FEISHU_APP_SECRET=leak ${calc}`)).not.toHaveProperty("credentialConsumer");
      expect(decision(`env PATH=/tmp ${calc}`)).not.toHaveProperty("credentialConsumer");
    });
  });

  describe("维度4:sessionWorkspace NO_PROXY 合并逻辑(buildSandboxEnv)", () => {
    it("已有小写 no_proxy 时,NO_PROXY 应合并不覆盖", () => {
      // buildSandboxEnv 在 hasProxy 且 shouldBypassProxyForFeishu() 时:
      // 从 env.NO_PROXY 或 env.no_proxy 读现有值,与飞书域名并入,写回两个变量
      // 清理宿主环境,避免继承污染
      const oldHTTP = process.env.HTTP_PROXY;
      const oldHTTPS = process.env.HTTPS_PROXY;
      const oldALL = process.env.ALL_PROXY;
      const oldNO = process.env.NO_PROXY;
      const oldNo = process.env.no_proxy;
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.ALL_PROXY;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;

      process.env.HTTP_PROXY = "http://proxy.test:8080"; // hasProxy 为真
      process.env.no_proxy = ".corp.com"; // 已有小写
      try {
        const sandboxEnv = buildSandboxEnv();
        // 应该包含 .corp.com 与 .feishu.cn 都合并进去
        const noproxy = sandboxEnv.NO_PROXY || sandboxEnv.no_proxy || "";
        expect(noproxy).toContain(".corp.com");
        expect(noproxy).toContain(".feishu.cn");
      } finally {
        delete process.env.HTTP_PROXY;
        delete process.env.no_proxy;
        if (oldHTTP) process.env.HTTP_PROXY = oldHTTP;
        if (oldHTTPS) process.env.HTTPS_PROXY = oldHTTPS;
        if (oldALL) process.env.ALL_PROXY = oldALL;
        if (oldNO) process.env.NO_PROXY = oldNO;
        if (oldNo) process.env.no_proxy = oldNo;
      }
    });

    it("飞书域名去重:已有 .feishu.cn 时不重复并入", () => {
      const oldHTTPS = process.env.HTTPS_PROXY;
      const oldNO = process.env.NO_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.NO_PROXY;

      process.env.HTTPS_PROXY = "http://proxy.test:8080";
      process.env.NO_PROXY = ".feishu.cn,.lark.com";
      try {
        const sandboxEnv = buildSandboxEnv();
        const noproxy = sandboxEnv.NO_PROXY || "";
        // 使用 Set 去重,应该只有一份 .feishu.cn
        const parts = noproxy.split(",").map((s) => s.trim());
        const count = parts.filter((p) => p === ".feishu.cn").length;
        expect(count).toBe(1);
        expect(parts).toContain(".feishu.cn");
        expect(parts).toContain(".lark.com");
      } finally {
        delete process.env.HTTPS_PROXY;
        delete process.env.NO_PROXY;
        if (oldHTTPS) process.env.HTTPS_PROXY = oldHTTPS;
        if (oldNO) process.env.NO_PROXY = oldNO;
      }
    });

    it("QINGAGENT_SANDBOX_FEISHU_NO_PROXY=0 时不并入飞书域名", () => {
      const oldHTTP = process.env.HTTP_PROXY;
      const oldQINGAGENT = process.env.QINGAGENT_SANDBOX_FEISHU_NO_PROXY;
      const oldNO = process.env.NO_PROXY;

      process.env.HTTP_PROXY = "http://proxy.test:8080";
      process.env.QINGAGENT_SANDBOX_FEISHU_NO_PROXY = "0";
      process.env.NO_PROXY = ".corp.com";
      try {
        const sandboxEnv = buildSandboxEnv();
        const noproxy = sandboxEnv.NO_PROXY || "";
        // 当 QINGAGENT_SANDBOX_FEISHU_NO_PROXY=0 时,shouldBypassProxyForFeishu() 返回 false,
        // 飞书域名并入逻辑被跳过,所以原值应原样返回
        expect(noproxy).toBe(".corp.com");
        // 飞书域名应不被并入
        expect(noproxy).not.toContain(".feishu.cn");
        expect(noproxy).not.toContain(".larksuite.com");
      } finally {
        delete process.env.HTTP_PROXY;
        delete process.env.QINGAGENT_SANDBOX_FEISHU_NO_PROXY;
        if (oldHTTP) process.env.HTTP_PROXY = oldHTTP;
        if (oldQINGAGENT) process.env.QINGAGENT_SANDBOX_FEISHU_NO_PROXY = oldQINGAGENT;
        if (oldNO) process.env.NO_PROXY = oldNO;
        else delete process.env.NO_PROXY;
      }
    });

    it("无代理时,飞书 NO_PROXY 并入逻辑被跳过", () => {
      // hasProxy 为假(未设任何 PROXY 变量)
      const oldHTTP = process.env.HTTP_PROXY;
      const oldHTTPS = process.env.HTTPS_PROXY;
      const oldALL = process.env.ALL_PROXY;
      const oldHttp = process.env.http_proxy;
      const oldHttps = process.env.https_proxy;
      const oldAll = process.env.all_proxy;
      const oldNO = process.env.NO_PROXY;

      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.ALL_PROXY;
      delete process.env.http_proxy;
      delete process.env.https_proxy;
      delete process.env.all_proxy;
      process.env.NO_PROXY = ".corp.com";
      try {
        const sandboxEnv = buildSandboxEnv();
        const noproxy = sandboxEnv.NO_PROXY || "";
        expect(noproxy).toBe(".corp.com");
        expect(noproxy).not.toContain(".feishu.cn");
      } finally {
        delete process.env.NO_PROXY;
        if (oldHTTP) process.env.HTTP_PROXY = oldHTTP;
        if (oldHTTPS) process.env.HTTPS_PROXY = oldHTTPS;
        if (oldALL) process.env.ALL_PROXY = oldALL;
        if (oldHttp) process.env.http_proxy = oldHttp;
        if (oldHttps) process.env.https_proxy = oldHttps;
        if (oldAll) process.env.all_proxy = oldAll;
        if (oldNO) process.env.NO_PROXY = oldNO;
      }
    });

    it("大小写都设(NO_PROXY 与 no_proxy):合并后同时更新两个", () => {
      const oldHTTP = process.env.HTTP_PROXY;
      const oldNO = process.env.NO_PROXY;
      const oldNo = process.env.no_proxy;
      delete process.env.HTTP_PROXY;
      delete process.env.NO_PROXY;
      delete process.env.no_proxy;

      process.env.HTTP_PROXY = "http://proxy.test:8080";
      process.env.NO_PROXY = ".corp.com";
      process.env.no_proxy = ".local";
      try {
        const sandboxEnv = buildSandboxEnv();
        // 当 NO_PROXY 与 no_proxy 都存在时,必须合并两边用户项再同步回两种大小写。
        const noproxy = sandboxEnv.NO_PROXY || "";
        expect(noproxy).toContain(".corp.com");
        expect(noproxy).toContain(".local");
        expect(noproxy).toContain(".feishu.cn");
        // 确认两个变量都被更新
        expect(sandboxEnv.NO_PROXY).toBeTruthy();
        expect(sandboxEnv.no_proxy).toBeTruthy();
        expect(sandboxEnv.no_proxy).toContain(".corp.com");
        expect(sandboxEnv.no_proxy).toContain(".local");
      } finally {
        delete process.env.HTTP_PROXY;
        delete process.env.NO_PROXY;
        delete process.env.no_proxy;
        if (oldHTTP) process.env.HTTP_PROXY = oldHTTP;
        if (oldNO) process.env.NO_PROXY = oldNO;
        if (oldNo) process.env.no_proxy = oldNo;
      }
    });
  });

  describe("维度4 扩展:NO_PROXY 合并边界情况", () => {
    it("多个 feishu 域名不重复", () => {
      const oldHTTP = process.env.HTTP_PROXY;
      const oldNO = process.env.NO_PROXY;
      delete process.env.HTTP_PROXY;
      delete process.env.NO_PROXY;

      process.env.HTTP_PROXY = "http://proxy.test:8080";
      process.env.NO_PROXY = ".feishu.cn,feishu.cn";
      try {
        const sandboxEnv = buildSandboxEnv();
        const noproxy = sandboxEnv.NO_PROXY || "";
        const parts = noproxy.split(",").map((s) => s.trim());
        // .feishu.cn 应该只出现一次
        const feishuCn = parts.filter((p) => p === ".feishu.cn").length;
        expect(feishuCn).toBe(1);
      } finally {
        delete process.env.HTTP_PROXY;
        delete process.env.NO_PROXY;
        if (oldHTTP) process.env.HTTP_PROXY = oldHTTP;
        if (oldNO) process.env.NO_PROXY = oldNO;
      }
    });

    it("空白 NO_PROXY 值被清理", () => {
      const oldHTTP = process.env.HTTP_PROXY;
      const oldNO = process.env.NO_PROXY;
      delete process.env.HTTP_PROXY;
      delete process.env.NO_PROXY;

      process.env.HTTP_PROXY = "http://proxy.test:8080";
      process.env.NO_PROXY = " , , .feishu.cn , ";
      try {
        const sandboxEnv = buildSandboxEnv();
        const noproxy = sandboxEnv.NO_PROXY || "";
        const parts = noproxy.split(",").map((s) => s.trim()).filter(Boolean);
        // 空字符串应被 filter(Boolean) 除掉
        expect(parts).not.toContain("");
        expect(parts).toContain(".feishu.cn");
      } finally {
        delete process.env.HTTP_PROXY;
        delete process.env.NO_PROXY;
        if (oldHTTP) process.env.HTTP_PROXY = oldHTTP;
        if (oldNO) process.env.NO_PROXY = oldNO;
      }
    });
  });
});
