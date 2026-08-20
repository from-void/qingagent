# Third-Party Notices / 第三方组件声明

QingAgent is licensed under the MIT License (see [LICENSE](./LICENSE)).
The official desktop distribution bundles the following third-party
components. Full license texts are available under
[docs/licenses/texts/](./docs/licenses/texts/) in this repository and are
shipped alongside the desktop installer.

## Bundled components(随桌面安装包分发)

### @larksuite/cli (lark-cli) — MIT

This product bundles `@larksuite/cli` 1.0.53, licensed under the MIT License.
Copyright (c) 2026 Lark Technologies Pte. Ltd. It also bundles MIT-licensed
runtime dependencies: `@clack/core`, `@clack/prompts`, `fast-string-width`,
`fast-string-truncated-width`, `fast-wrap-ansi`, and `sisteransi`.

### Pyodide — MPL-2.0

This product bundles Pyodide 0.29.4 runtime files (`pyodide.mjs`,
`pyodide.asm.js`, `pyodide.asm.wasm`, `python_stdlib.zip`,
`pyodide-lock.json`). No local modifications were made. Pyodide is licensed
under the Mozilla Public License 2.0; source code is available from
<https://github.com/pyodide/pyodide>. The MPL-2.0 license text is included at
[docs/licenses/texts/MPL-2.0.txt](./docs/licenses/texts/MPL-2.0.txt).

### QingYanShiSubset webfont — SIL OFL-1.1

This product includes a subset/renamed webfont derived from
"Slidechunfeng Regular"(<https://github.com/FWHP-Enfun/Slide-Font>),
licensed under the SIL Open Font License 1.1. The font file is distributed as
"QingYanShiSubset" and is not sold separately. Its internal font name table
has also been rebuilt to use the QingYanShiSubset family/full/PostScript names.
The OFL-1.1 license text is included at
[docs/licenses/texts/OFL-1.1.txt](./docs/licenses/texts/OFL-1.1.txt).

### LXGW WenKai Regular 1.520 webfont — SIL OFL-1.1

This product redistributes `LXGWWenKai-Regular.woff2`, whose embedded font
metadata identifies it as LXGW WenKai Regular version 1.520 (June 14, 2025).
It is from the [LXGW WenKai project](https://github.com/lxgw/LxgwWenKai),
which is derived from Fontworks' Klee One. The original copyright notices and
license are included at
[apps/web/public/fonts/LICENSE-LXGWWenKai.txt](./apps/web/public/fonts/LICENSE-LXGWWenKai.txt).
The SIL Open Font License 1.1 text is included at
[docs/licenses/texts/OFL-1.1.txt](./docs/licenses/texts/OFL-1.1.txt).

### Smiley Sans Oblique 2.0.1 webfont — SIL OFL-1.1

This product redistributes `SmileySans-Oblique.woff2`, version 2.0.1, from
the [Smiley Sans project](https://github.com/atelier-anchor/smiley-sans) by
atelierAnchor. The original copyright notice and license are included at
[apps/web/public/fonts/LICENSE-SmileySans.txt](./apps/web/public/fonts/LICENSE-SmileySans.txt).
The SIL Open Font License 1.1 text is included at
[docs/licenses/texts/OFL-1.1.txt](./docs/licenses/texts/OFL-1.1.txt).

## Notable runtime dependencies(以依赖形式分发,特殊许可)

### elkjs — EPL-2.0

This product depends on `elkjs` 0.11.1 (Eclipse Layout Kernel for JavaScript),
licensed under the Eclipse Public License 2.0. Source code is available from
<https://github.com/kieler/elkjs>. No modifications were made. The EPL-2.0
license text is included at
[docs/licenses/texts/EPL-2.0.md](./docs/licenses/texts/EPL-2.0.md).

### @promptbook/utils — CC-BY-4.0

This product depends on `@promptbook/utils` 0.69.5 (via the
`@mastra/agent-browser` dependency chain), licensed under Creative Commons
Attribution 4.0 (<https://creativecommons.org/licenses/by/4.0/>).
Attribution: Promptbook, <https://github.com/webgptorg/promptbook>.
No modifications were made.

### dompurify — MPL-2.0 OR Apache-2.0

`dompurify` 3.4.10 is dual-licensed; this product elects to receive it under
the Apache License 2.0.

### css-value — MIT (upstream declaration)

`css-value` 0.0.1 ships without a license field in its package metadata. The
upstream README (<https://github.com/reworkcss/css-value>) declares the MIT
License; this notice records that declaration as the licensing basis.

## Fonts loaded at runtime(运行时按需加载,不随仓库分发)

The web app may load Noto Sans SC, Noto Serif SC, and JetBrains Mono via
Google Fonts. These fonts are licensed under the SIL Open Font License 1.1
and are not redistributed in this repository. If a future build bundles or
caches these font files, their license texts must be included here.
