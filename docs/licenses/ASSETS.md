# 资产台账(Assets Ledger)

仓库内随发行分发的非代码资产的来源与许可记录。新增资产时在此登记。

| 资产 | 位置 | 来源与许可 | 说明 |
|---|---|---|---|
| 精选背景图(70 文件,6 png + 64 jpg) | `apps/web/public/chinese-masonry-assets/curated-backgrounds/` | 作者使用 AI 生成,无第三方版权主张 | 随仓库以 MIT 分发 |
| 书法字体子集 `yanshi-colophon-subset.woff2` | `apps/web/src/assets/` | 源自 Slidechunfeng Regular(OFL-1.1,<https://github.com/FWHP-Enfun/Slide-Font>),子集化并更名 `QingYanShiSubset` | 声明见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md);字体内部 name table 已重造为 `QingYanShiSubset`,并经 fc-scan 验收 |
| 瀑布流组件 | `apps/web/src/system/chinese-masonry/` | 从本机独立 MIT 仓库收编，出身说明见目录内 `README.md` | 作为 web 内部基础组件维护 |
| Google Fonts 引用(Noto Sans SC / Noto Serif SC / JetBrains Mono) | `apps/web/index.html`、导出 HTML | OFL-1.1,运行时按需加载 | 不构成仓库再分发;若日后打包缓存须补 NOTICE |
| 印章/装饰类 UI 资产 | `apps/web/src/assets/` | 作者自制 | 随仓库以 MIT 分发 |
