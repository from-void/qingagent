import { describe, expect, it } from "vitest";
import { skillToMenuAction } from "./skillDisplay";

describe("skillToMenuAction", () => {
  it("行内保留短摘要，同时把完整 description 交给 tooltip", () => {
    const action = skillToMenuAction({
      name: "lark-shared",
      label: "lark-shared",
      summary: "Use when first setting up lark-cli,…",
      description: "Use for lark-cli setup/auth tasks and permissions.",
      icon: "star",
      enabled: true,
      userInvocable: true,
    });

    expect(action.description).toBe("Use when first setting up lark-cli,…");
    expect(action.fullDescription).toBe("Use for lark-cli setup/auth tasks and permissions.");
  });
});
