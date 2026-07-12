# chinese-masonry — 工程内部包

本包最初从本机独立 `chinese-masonry` 仓库并入，源码采用 MIT 许可；现已收编为
`@qingagent/chinese-masonry` 私有 workspace 包，不再作为独立组件库发布。

当前仅保留 `apps/web` 首页画廊实际使用的卡片渲染、模板注册与选择代码。精选背景图
由项目作者使用 AI 生成，运行时统一从
`apps/web/public/chinese-masonry-assets/curated-backgrounds/` 提供，不在包内保留副本。

历史构建产物 `dist/`、模板编辑器、独立瀑布流组件和旧生成资产已删除；web 通过包
`exports` 直接编译 `src/` 源码。
