# draw.io 离线编辑器静态资产

- 来源：jgraph/drawio `v31.0.2`
- 上游地址：https://github.com/jgraph/drawio/archive/refs/tags/v31.0.2.tar.gz
- License：Apache-2.0，许可证全文见 `LICENSE`
- 产品入口：`/drawio/index.html?embed=1&proto=json&spin=1&offline=1&lang=zh`

## 裁剪范围

保留官方生产入口、生产压缩包 `app.min.js`、核心 shape/stencil/extension
压缩包、编辑器 CSS、SVG MathJax 运行时、必要图片，以及英文默认资源
`resources/dia.txt` 和简体中文 `resources/dia_zh.txt`。

保留 MathJax 而非关闭公式能力；其 `core/input/output/startup/ui/font` 七类
必需模块均由 `check-drawio-vendor.mjs` 校验。特别是路径名为
`math4/es5/output/svg.js` 的生产文件必须显式越过仓库通用 `output/`
忽略规则，避免 fresh checkout 再次出现运行时 404。

移除源码级 JS、服务端 `WEB-INF/META-INF`、云盘/协作集成页、service worker、
插件、示例、模板、文档、可选扩展 stencil XML、非 zh/en locale、未被离线
embed 启动路径请求的图片与 MathJax CHTML/扩展字体。核心图形库仍由官方
`js/shapes-14-6-5.min.js` 与 `js/stencils.min.js` 提供。

## 升级复现

```bash
node apps/web/scripts/vendor-drawio.mjs
# 已有上游源码时可跳过下载
node apps/web/scripts/vendor-drawio.mjs --source /path/to/drawio
node apps/web/scripts/check-drawio-vendor.mjs
```

`PreConfig.js` / `PostConfig.js` 由脚本覆盖为离线配置：强制
`offline=1`、禁用插件/云服务/日志/通知/实时协作/图标搜索，只声明 zh/en locale。
官方生产 bundle 内仍含被 `offline=1` 分支禁止执行的云服务端点字符串；运行时
网络审计只允许当前应用同源的 `/drawio/` 请求。
