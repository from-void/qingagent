import { describe, expect, it } from "vitest";
import {
  credentialPathError,
  readCredentialPathsFromFrontmatter,
} from "../credentialPaths.js";
import { assertCredentialPathsValid } from "../skillFiles.js";

describe("qa CLI 的 credential-paths 校验", () => {
  it("放行 HOME 下的普通凭证目录", () => {
    expect(credentialPathError("~/.yuque")).toBeNull();
    expect(credentialPathError("~/.config/yuque/credentials.json")).toBeNull();
  });

  it("拒绝越界与非 ~/ 写法", () => {
    expect(credentialPathError("~/../etc")).toBe("凭证路径不能包含 .. ");
    expect(credentialPathError("/etc/shadow")).toBe("凭证路径必须以 ~/ 开头");
    expect(credentialPathError(".yuque")).toBe("凭证路径必须以 ~/ 开头");
    expect(credentialPathError("~")).toBe("凭证路径不能是整个用户目录");
  });

  it("拒绝浏览器数据与钥匙串", () => {
    expect(credentialPathError("~/Library/Keychains")).toBe("浏览器数据和系统钥匙串不可共享");
    expect(credentialPathError("~/.config/google-chrome/Default")).toBe(
      "浏览器数据和系统钥匙串不可共享",
    );
    expect(credentialPathError("~/.local/share/keyrings")).toBe("浏览器数据和系统钥匙串不可共享");
    expect(credentialPathError("~/Library")).toBe("浏览器数据和系统钥匙串不可共享");
  });
});

describe("从 frontmatter 取声明", () => {
  it("多行列表", () => {
    const source = "---\nname: demo\ndescription: d\ncredential-paths:\n  - ~/.yuque\n  - ~/.lark-cli\n---\n";
    expect(readCredentialPathsFromFrontmatter(source)).toEqual(["~/.yuque", "~/.lark-cli"]);
  });

  it("行内数组", () => {
    const source = '---\nname: demo\ndescription: d\ncredential-paths: [~/.yuque, "~/.lark-cli"]\n---\n';
    expect(readCredentialPathsFromFrontmatter(source)).toEqual(["~/.yuque", "~/.lark-cli"]);
  });

  it("没声明时为空", () => {
    expect(readCredentialPathsFromFrontmatter("---\nname: demo\ndescription: d\n---\n")).toEqual([]);
  });
});

describe("assertCredentialPathsValid", () => {
  it("合法声明通过", () => {
    expect(() =>
      assertCredentialPathsValid("---\nname: d\ndescription: d\ncredential-paths:\n  - ~/.yuque\n---\n", "SKILL.md"),
    ).not.toThrow();
  });

  it("非法声明抛中文校验错误", () => {
    expect(() =>
      assertCredentialPathsValid(
        "---\nname: d\ndescription: d\ncredential-paths:\n  - ~/../etc\n---\n",
        "SKILL.md",
      ),
    ).toThrow(/credential-paths 不合法/);
  });
});
