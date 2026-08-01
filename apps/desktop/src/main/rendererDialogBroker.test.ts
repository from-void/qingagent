import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DESKTOP_DIALOG_REQUEST_CHANNEL,
  type DesktopDialogRequest,
} from "../rendererDialogContract.js";
import {
  RendererDialogBroker,
  type RendererDialogTarget,
} from "./rendererDialogBroker.js";

function createTarget(id: number) {
  const sent: Array<{ channel: string; payload: DesktopDialogRequest }> = [];
  let destroyed = false;
  const target: RendererDialogTarget = {
    id,
    isDestroyed: () => destroyed,
    send: (channel, payload) => {
      sent.push({ channel, payload });
    },
  };
  return {
    target,
    sent,
    destroy: () => {
      destroyed = true;
    },
  };
}

describe("renderer dialog broker", () => {
  it("renderer 声明能力后发送自绘请求，并只接受原窗口回执", async () => {
    const broker = new RendererDialogBroker();
    const owner = createTarget(1);
    const other = createTarget(2);
    broker.markReady(owner.target, ["quit-during-generation"]);

    const decision = broker.request(owner.target, "quit-during-generation");
    assert.equal(owner.sent.length, 1);
    assert.equal(owner.sent[0]?.channel, DESKTOP_DIALOG_REQUEST_CHANNEL);
    assert.equal(owner.sent[0]?.payload.kind, "quit-during-generation");
    assert.equal(
      broker.respond(other.target, {
        id: owner.sent[0]!.payload.id,
        result: "confirm",
      }),
      false,
    );
    assert.equal(
      broker.respond(owner.target, {
        id: owner.sent[0]!.payload.id,
        result: "cancel",
      }),
      true,
    );
    assert.equal(await decision, "cancel");
  });

  it("未就绪、能力不匹配或已销毁时明确返回 unavailable", async () => {
    const broker = new RendererDialogBroker();
    const owner = createTarget(1);

    assert.equal(await broker.request(owner.target, "quit-during-generation"), null);
    broker.markReady(owner.target, ["content-load-failed"]);
    assert.equal(await broker.request(owner.target, "quit-during-generation"), null);
    owner.destroy();
    assert.equal(await broker.request(owner.target, "content-load-failed"), null);
  });

  it("主 frame 导航或 renderer 失联会释放正在等待的确认", async () => {
    const broker = new RendererDialogBroker();
    const owner = createTarget(1);
    broker.markReady(owner.target, ["quit-during-generation"]);

    const decision = broker.request(owner.target, "quit-during-generation");
    broker.markUnavailable(owner.target);

    assert.equal(await decision, null);
    assert.equal(await broker.request(owner.target, "quit-during-generation"), null);
  });
});
