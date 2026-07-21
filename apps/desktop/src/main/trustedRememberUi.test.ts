import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRememberPromptCopy,
  buildRememberPromptHtml,
  NativeRememberGrantGate,
  TrustedRememberUiGate,
} from "./trustedRememberUi.js";

function validInput() {
  return {
    senderId: 7,
    mainWindowSenderId: 7,
    windowFocused: true,
    senderIsDevtools: false,
  };
}

test("真实键鼠输入可消费一次，程序化调用与重放拒绝", () => {
  const gate = new TrustedRememberUiGate(() => 1_000);
  assert.equal(gate.consume(validInput()), false);
  gate.record(7, "mouseDown");
  assert.equal(gate.consume(validInput()), true);
  assert.equal(gate.consume(validInput()), false);
});

test("非主窗口、失焦和 devtools 拒绝且消费输入", () => {
  for (const overrides of [
    { senderId: 8 },
    { mainWindowSenderId: 8 },
    { windowFocused: false },
    { senderIsDevtools: true },
  ]) {
    const gate = new TrustedRememberUiGate(() => 1_000);
    gate.record(7, "keyDown");
    assert.equal(gate.consume({ ...validInput(), ...overrides }), false);
    assert.equal(gate.consume(validInput()), false);
  }
});

test("过期输入、keyup 和时间倒退均拒绝", () => {
  let now = 1_000;
  const gate = new TrustedRememberUiGate(() => now);
  gate.record(7, "keyUp");
  assert.equal(gate.consume(validInput()), false);

  gate.record(7, "keyDown");
  now = 3_001;
  assert.equal(gate.consume(validInput()), false);

  now = 5_000;
  gate.record(7, "mouseDown");
  now = 4_999;
  assert.equal(gate.consume(validInput()), false);
});

test("自绘确认窗使用统一三层文案与产品皮肤", () => {
  const install = buildRememberPromptCopy({ kind: "install" });
  assert.deepEqual(install, {
    title: "要记住这次选择吗？",
    message: "以后安装时不再询问",
    detail: "开启后，之后的安装会直接进行。安装内容可能会改变这台电脑上的软件或设置。可在 设置 → 安全 中恢复每次询问。",
    rememberLabel: "记住",
    cancelLabel: "暂不",
  });
  const command = buildRememberPromptCopy({ kind: "command" });
  assert.equal(command.message, "以后遇到同类操作不再询问");
  assert.match(command.detail, /同类操作会直接进行/);

  const html = buildRememberPromptHtml(install);
  assert.match(html, /--night:#10191d/);
  assert.match(html, /--paper:#faf6ec/);
  assert.match(html, /font-family:"Noto Serif SC","Songti SC","STSong",serif/);
  assert.match(html, /id="prompt-remember"/);
  assert.match(html, /id="prompt-cancel"/);
  assert.doesNotMatch(html, /默认同意|逐次|安装指令|运行环境/);
});

test("自绘确认取消时返回 null 且不登记 nonce", async () => {
  const gate = new NativeRememberGrantGate();
  let registered = 0;
  const nonce = await gate.request({
    purpose: "confirm",
    kind: "install",
    showPrompt: async (copy) => {
      assert.equal(copy.title, "要记住这次选择吗？");
      assert.equal(copy.message, "以后安装时不再询问");
      assert.match(copy.detail, /这台电脑上的软件或设置/);
      assert.equal(copy.rememberLabel, "记住");
      assert.equal(copy.cancelLabel, "暂不");
      return "cancel";
    },
    register: () => {
      registered += 1;
      return "must-not-register";
    },
  });

  assert.equal(nonce, null);
  assert.equal(registered, 0);
});

test("自绘确认同意后只登记一次 nonce", async () => {
  const gate = new NativeRememberGrantGate();
  let registered = 0;
  const nonce = await gate.request({
    purpose: "settings",
    kind: "command",
    showPrompt: async (copy) => {
      assert.equal(copy.message, "以后遇到同类操作不再询问");
      assert.match(copy.detail, /开启后，之后的同类操作/);
      return "remember";
    },
    register: () => {
      registered += 1;
      return "registered-once";
    },
  });

  assert.equal(nonce, "registered-once");
  assert.equal(registered, 1);
});

test("自绘确认未决期间拒绝重复请求且不叠窗", async () => {
  const gate = new NativeRememberGrantGate();
  let resolvePrompt!: (result: "remember" | "cancel") => void;
  let shown = 0;
  let registered = 0;
  const first = gate.request({
    purpose: "confirm",
    kind: "command",
    showPrompt: (copy) => {
      shown += 1;
      assert.match(copy.detail, /之后的同类操作/);
      return new Promise((resolve) => {
        resolvePrompt = resolve;
      });
    },
    register: () => {
      registered += 1;
      return "first-nonce";
    },
  });
  const second = await gate.request({
    purpose: "settings",
    kind: "install",
    showPrompt: async () => {
      shown += 1;
      return "remember";
    },
    register: () => "second-nonce",
  });

  assert.equal(second, null);
  assert.equal(shown, 1);
  assert.equal(registered, 0);
  resolvePrompt("remember");
  assert.equal(await first, "first-nonce");
  assert.equal(registered, 1);
});

test("窗口关闭取消旧 modal，重开后可请求且旧回调不得登记 nonce", async () => {
  const gate = new NativeRememberGrantGate();
  const oldGeneration = gate.reset();
  let resolveOldPrompt!: (result: "remember" | "cancel") => void;
  let oldRegistered = 0;
  const oldRequest = gate.request({
    purpose: "confirm",
    kind: "command",
    generation: oldGeneration,
    showPrompt: () => new Promise((resolve) => { resolveOldPrompt = resolve; }),
    register: () => {
      oldRegistered += 1;
      return "old-nonce";
    },
  });

  gate.cancel(oldGeneration);
  const newGeneration = gate.reset();
  const newRequest = gate.request({
    purpose: "confirm",
    kind: "install",
    generation: newGeneration,
    showPrompt: async () => "remember",
    register: () => "new-nonce",
  });
  resolveOldPrompt("remember");

  assert.equal(await oldRequest, null);
  assert.equal(oldRegistered, 0);
  assert.equal(await newRequest, "new-nonce");
});

test("窗口在 nonce 登记过程中关闭会撤销刚签发的旧 nonce", async () => {
  const gate = new NativeRememberGrantGate();
  const generation = gate.reset();
  let resolveRegister!: (nonce: string) => void;
  const revoked: string[] = [];
  const request = gate.request({
    purpose: "settings",
    kind: "command",
    generation,
    showPrompt: async () => "remember",
    register: () => new Promise((resolve) => { resolveRegister = resolve; }),
    revoke: (nonce) => { revoked.push(nonce); },
  });
  await Promise.resolve();
  gate.cancel(generation);
  resolveRegister("stale-nonce");

  assert.equal(await request, null);
  assert.deepEqual(revoked, ["stale-nonce"]);
});
