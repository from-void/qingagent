import { describe, expect, it } from "vitest";
import { redactProbe } from "../workspace/probeRedaction.js";

describe("redactProbe", () => {
  it("递归替换本地路径,环境变量只保留路径形态", () => {
    const redacted = redactProbe(
      {
        main: {
          execPath: "/opt/Qingagent/Qingagent",
          resourcesPath: "/opt/Qingagent/resources",
          env: {
            PATH: "/home/me/.qingagent/data/bin:/usr/bin",
            FEISHU_APP_SECRET: "secret",
            nested: { TOKEN: "secret-2" },
          },
        },
        files: [
          "/home/me/.qingagent/data/probes/a.json",
          "/opt/Qingagent/resources/skills/capability/doc-calc",
        ],
      },
      {
        dataDir: "/home/me/.qingagent/data",
        resourcesPath: "/opt/Qingagent/resources",
        sandboxBinDir: "/home/me/.qingagent/data/bin",
        execDir: "/opt/Qingagent",
      },
    );

    expect(redacted.main.execPath).toBe("<EXEC_DIR>/Qingagent");
    expect(redacted.main.resourcesPath).toBe("<RESOURCES>");
    expect(redacted.main.env.PATH).toBe("<SANDBOX_BIN_DIR>:/usr/bin");
    expect(redacted.main.env.FEISHU_APP_SECRET).toBe("<redacted>");
    expect(redacted.main.env.nested).toEqual({ TOKEN: "<redacted>" });
    expect(redacted.files).toEqual([
      "<DATA_DIR>/probes/a.json",
      "<RESOURCES>/skills/capability/doc-calc",
    ]);
  });
});
