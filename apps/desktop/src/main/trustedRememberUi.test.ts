import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("原生确认取消时返回 null 且不登记 nonce", async () => {
  const gate = new NativeRememberGrantGate();
  let registered = 0;
  const nonce = await gate.request({
    purpose: "confirm",
    kind: "install",
    showMessageBox: async (options) => {
      assert.equal(options.title, "记住这类操作？");
      assert.match(options.message, /安装指令/);
      assert.match(options.detail, /直接执行/);
      assert.deepEqual(options.buttons, ["记住", "暂不"]);
      assert.equal(options.defaultId, 1);
      assert.equal(options.cancelId, 1);
      return { response: 1 };
    },
    register: () => {
      registered += 1;
      return "must-not-register";
    },
  });

  assert.equal(nonce, null);
  assert.equal(registered, 0);
});

test("原生确认同意后只登记一次 nonce", async () => {
  const gate = new NativeRememberGrantGate();
  let registered = 0;
  const nonce = await gate.request({
    purpose: "settings",
    kind: "command",
    showMessageBox: async (options) => {
      assert.match(options.message, /此类命令/);
      assert.match(options.detail, /开启后，同类命令/);
      return { response: 0 };
    },
    register: () => {
      registered += 1;
      return "registered-once";
    },
  });

  assert.equal(nonce, "registered-once");
  assert.equal(registered, 1);
});

test("原生确认未决期间拒绝重复请求且不叠框", async () => {
  const gate = new NativeRememberGrantGate();
  let resolveDialog!: (result: { response: number }) => void;
  let shown = 0;
  let registered = 0;
  const first = gate.request({
    purpose: "confirm",
    kind: "command",
    showMessageBox: (options) => {
      shown += 1;
      assert.match(options.detail, /以后的同类命令/);
      return new Promise((resolve) => {
        resolveDialog = resolve;
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
    showMessageBox: async () => {
      shown += 1;
      return { response: 0 };
    },
    register: () => "second-nonce",
  });

  assert.equal(second, null);
  assert.equal(shown, 1);
  assert.equal(registered, 0);
  resolveDialog({ response: 0 });
  assert.equal(await first, "first-nonce");
  assert.equal(registered, 1);
});
