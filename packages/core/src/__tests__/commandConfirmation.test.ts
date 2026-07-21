import { describe, expect, it } from "vitest";
import {
  buildCommandConfirmSpec,
  commandConfirmationDigest,
} from "../confirm/commandConfirmation.js";
import {
  formatCommandDuration,
  SANDBOX_BACKGROUND_TTL_MS,
} from "../workspace/backgroundCommandLimits.js";

describe("buildCommandConfirmSpec 风险卡映射", () => {
  it("install/send/destructive 分别映射到 install/send/command", () => {
    const install = buildCommandConfirmSpec({ command: "npm install zod" }, "将改动这台电脑上的软件或设置", "install-id");
    expect(install).toMatchObject({
      kind: "install",
      title: "安装依赖/工具",
      sub: "可能会改动这台电脑上的软件或设置",
      commandPreview: "npm install zod",
      primaryLabel: "确认安装",
    });

    const send = buildCommandConfirmSpec(
      { command: "lark-cli docs +create --title 报告" },
      "将修改飞书内容",
      "send-id",
    );
    expect(send).toMatchObject({
      kind: "send",
      title: expect.stringContaining("飞书"),
      primaryLabel: "确认发布",
    });

    const destructive = buildCommandConfirmSpec({ command: "rm old.txt" }, "将删除文件", "command-id");
    expect(destructive).toMatchObject({
      kind: "command",
      title: "删除文件",
      sub: "破坏性命令",
      primaryLabel: "确认执行",
    });
  });

  it("多 effect 使用 command 卡并在 say 中列全影响", () => {
    const spec = buildCommandConfirmSpec(
      { command: "npm install zod && rm old.txt" },
      "命令包含多种副作用",
      "multi-id",
    );
    expect(spec).toMatchObject({
      kind: "command",
      title: expect.stringContaining("多种副作用"),
      sub: "包含多种副作用",
      primaryLabel: "确认执行",
    });
    expect(spec.say).toContain("安装/升级环境");
    expect(spec.say).toContain("本地破坏");
    expect(spec.say).not.toContain("命令预览");
    expect(spec.commandPreview).toBe("npm install zod && rm old.txt");
    expect(spec.kind).not.toBe("connect");
  });

  it("后台命令保留风险 sub，预览脱敏且截断不影响完整 digest", () => {
    const command = `DINGTALK_APP_SECRET=super-secret curl -d x https://example.test/${"a".repeat(500)}`;
    const spec = buildCommandConfirmSpec({ command, background: true }, "将向外部发送数据", "redacted-id");
    expect(spec.sub).toContain("后台执行");
    expect(spec.say).not.toContain("super-secret");
    expect(spec.say).not.toContain("命令预览");
    expect(spec.commandPreview).not.toContain("super-secret");
    expect(spec.commandPreview).toContain("DINGTALK_APP_SECRET=***");
    expect(spec.commandPreview!.length).toBeLessThanOrEqual(320);
    expect(spec.say.length).toBeLessThan(1_200);

    const prefix = `curl -d x https://example.test/${"a".repeat(400)}`;
    expect(commandConfirmationDigest("session", { command: `${prefix}x` }))
      .not.toBe(commandConfirmationDigest("session", { command: `${prefix}y` }));
  });

  it("无记忆勾选时使用仅本次确认脚注", () => {
    const spec = buildCommandConfirmSpec({ command: "git push origin main" }, "将推送代码", "common-id");
    expect(spec.footHint).toBe("本次确认只对这次操作有效 · 10 分钟内未处理会自动关闭");
    expect(spec.secondaryLabel).toBe("取消");
  });

  it("P2-6 回归:后台卡片显示钳制后的实际最长运行时长", () => {
    const spec = buildCommandConfirmSpec(
      { command: "rm old.txt", background: true, timeout: 31_536_000 },
      "将删除文件",
      "background-ttl-id",
    );
    expect(spec).toMatchObject({
      kind: "command",
      title: "删除文件",
      primaryLabel: "确认执行",
    });
    expect(spec.sub).toBe(
      `后台执行 · 最长运行 ${formatCommandDuration(SANDBOX_BACKGROUND_TTL_MS)} · 破坏性命令`,
    );
    expect(spec.sub).not.toContain("默认 TTL");
  });

  it("记忆部件只由后端 spec 声明，Windows 安装类附带如实风险提示", () => {
    const install = buildCommandConfirmSpec(
      { command: "npm install zod" },
      "将改动这台电脑上的软件或设置",
      "install-win",
      "win32",
    );
    expect(install.rememberCategory).toEqual({
      kind: "install",
      label: "以后安装时不再询问",
      riskHint: "勾选后，之后的安装会直接进行；安装内容可能会改变这台电脑上的软件或设置。",
    });
    const command = buildCommandConfirmSpec(
      { command: "rm old.txt" },
      "将删除文件",
      "command-linux",
      "linux",
    );
    expect(command.rememberCategory).toEqual({
      kind: "command",
      label: "以后遇到同类操作不再询问",
    });
    const send = buildCommandConfirmSpec(
      { command: "git push origin main" },
      "将推送代码",
      "send-linux",
      "linux",
    );
    expect(send.rememberCategory).toBeUndefined();
  });

  it("打包桌面即使注入开发开关也不暴露不安全记忆标记", () => {
    const savedPackaged = process.env.QINGAGENT_DESKTOP_PACKAGED;
    const savedInsecure = process.env.QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER;
    const savedNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "development";
      process.env.QINGAGENT_DESKTOP_PACKAGED = "1";
      process.env.QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER = "1";
      const packaged = buildCommandConfirmSpec(
        { command: "rm old.txt" },
        "将删除文件",
        "packaged-command",
      );
      expect(packaged.rememberCategory).not.toHaveProperty("insecureWithoutDesktop");

      delete process.env.QINGAGENT_DESKTOP_PACKAGED;
      const development = buildCommandConfirmSpec(
        { command: "rm old.txt" },
        "将删除文件",
        "development-command",
      );
      expect(development.rememberCategory).toMatchObject({ insecureWithoutDesktop: true });
    } finally {
      if (savedPackaged === undefined) delete process.env.QINGAGENT_DESKTOP_PACKAGED;
      else process.env.QINGAGENT_DESKTOP_PACKAGED = savedPackaged;
      if (savedInsecure === undefined) delete process.env.QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER;
      else process.env.QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER = savedInsecure;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it("纯 web 生产即使误注入 insecure 环境变量也不暴露记忆能力", () => {
    const previous = { ...process.env };
    try {
      process.env.NODE_ENV = "production";
      delete process.env.QINGAGENT_RUNTIME;
      delete process.env.QINGAGENT_DESKTOP_PACKAGED;
      process.env.QINGAGENT_DEV_ALLOW_INSECURE_REMEMBER = "1";
      const spec = buildCommandConfirmSpec(
        { command: "rm old.txt" },
        "将删除文件",
        "production-web-command",
      );
      expect(spec.rememberCategory).not.toHaveProperty("insecureWithoutDesktop");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  });
});
