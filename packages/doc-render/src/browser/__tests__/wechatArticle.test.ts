import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractWechatArticle, isWechatArticleUrl } from "../wechatArticle.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

async function readFixture(name: string): Promise<string> {
  return readFile(join(currentDir, "fixtures", name), "utf-8");
}

describe("wechatArticle", () => {
  it("识别微信公众号文章 URL", () => {
    expect(isWechatArticleUrl("https://mp.weixin.qq.com/s/xxx")).toBe(true);
    expect(isWechatArticleUrl("https://sub.mp.weixin.qq.com/s/xxx")).toBe(true);
    expect(isWechatArticleUrl("https://example.com")).toBe(false);
  });

  it("从微信文章 DOM 清洗出 Markdown 和 data-src 图片", async () => {
    const html = await readFixture("wx-weekly-331.html");
    const result = extractWechatArticle(html, "https://mp.weixin.qq.com/s/xxx");

    expect(result.title).toBe("科技爱好者周刊#331：你可能是一个 NPC");
    expect(result.images.length).toBeGreaterThanOrEqual(40);
    expect(result.images.every((image) => image.src.includes("mmbiz.qpic.cn"))).toBe(true);
    expect(result.markdown).toContain("## ");
    expect(result.markdown).toContain("这里记录每周值得分享的科技内容");
    expect(result.markdown).not.toContain("扫码关注");
    expect(result.markdown).not.toContain("推荐阅读");
    expect(result.markdown).not.toContain("往期回顾");
    expect(result.markdown).not.toContain("工具栏噪声");
  });

  it("表格转 Markdown 表、代码块保围栏、正文内噪声块删除、data-src 图入图", () => {
    const html = `<div id="js_content">
      <p>方案对比：</p>
      <table><thead><tr><th>方案</th><th>成本</th></tr></thead>
        <tbody><tr><td>A</td><td>低</td></tr><tr><td>B</td><td>高</td></tr></tbody></table>
      <pre><code>def f():
    return 1</code></pre>
      <div class="video_iframe">视频号卡片占位</div>
      <div id="js_profile_qrcode">扫码关注我们</div>
      <p><img data-src="https://mmbiz.qpic.cn/x/640" alt="图"></p>
    </div>`;
    const result = extractWechatArticle(html, "https://mp.weixin.qq.com/s/yyy");

    // 表格 → Markdown 表(表头 + 分隔行)
    expect(result.markdown).toContain("| 方案 | 成本 |");
    expect(result.markdown).toContain("| --- | --- |");
    // 代码块保围栏
    expect(result.markdown).toContain("```");
    expect(result.markdown).toContain("def f():");
    // 正文内噪声块删除
    expect(result.markdown).not.toContain("视频号卡片");
    expect(result.markdown).not.toContain("扫码关注");
    // data-src 懒加载图入图 + Markdown
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.src).toBe("https://mmbiz.qpic.cn/x/640");
    expect(result.markdown).toContain("![图](https://mmbiz.qpic.cn/x/640)");
  });

  it("pre 代码块用 <br> 换行时保留多行,不塌成一行(review #2)", () => {
    const html = `<div id="js_content"><pre><code>const a = 1;<br>const b = 2;<br>return a + b;</code></pre></div>`;
    const result = extractWechatArticle(html, "https://mp.weixin.qq.com/s/pre");
    expect(result.markdown).toContain("```");
    expect(result.markdown).toContain("const a = 1;\nconst b = 2;\nreturn a + b;");
  });

  it("保留 fenced code block 内的空行与纯标点末段", () => {
    const html = `<div id="js_content">
      <pre>function run() {<br>  call();<br><br>});</pre>
      <p>代码之后的正文</p>
    </div>`;
    const result = extractWechatArticle(html, "https://mp.weixin.qq.com/s/fenced-code");

    expect(result.markdown).toContain("```\nfunction run() {\n  call();\n\n});\n```");
    expect(result.markdown).toContain("```\n\n代码之后的正文");
  });

  it("正文内漏网的 <script> 不吐成正文(review #8)", () => {
    const html = `<div id="js_content"><p>正文段落。</p><script>alert('x'); var secret=1;</script></div>`;
    const result = extractWechatArticle(html, "https://mp.weixin.qq.com/s/sc");
    expect(result.markdown).toContain("正文段落");
    expect(result.markdown).not.toContain("alert");
    expect(result.markdown).not.toContain("secret");
  });
});
