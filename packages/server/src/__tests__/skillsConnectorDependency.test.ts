import { describe, expect, it } from "vitest";
import { connectorIdForSkill } from "../routes/skills";

describe("skills connectorId 反查", () => {
  it("以 connector registry.usedBySkills 为唯一关系源", () => {
    expect(connectorIdForSkill("feishu")).toBe("feishu");
    expect(connectorIdForSkill("wechat-official-account")).toBe("wechat-mp");
    expect(connectorIdForSkill("github-materials")).toBe("github");
    expect(connectorIdForSkill("web-search")).toBeUndefined();
  });
});
