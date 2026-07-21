import assert from "node:assert/strict";
import test from "node:test";
import { TrustedRememberUiGate } from "./trustedRememberUi.js";

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
