# chinese-masonry — 源码已并入（过渡态）

本包原为**预构建产物的 vendor 副本**。现已把上游源码并入本仓库，处于「源码在仓库 + 仍消费预构建 dist」的过渡态，便于将来彻底解耦（独立 build / 发包）。

## 当前消费方式（不变）

- `@qingagent/web` 仍以 `workspace:*` 直接消费 **`dist/chinese-masonry.js`**（ESM 成品，已提交进 git）。
- `package.json` 的 `module`/`exports` 指向 `dist/`，**未接 build-from-source**。
- 本包仍**没有 build / typecheck 脚本**，`pnpm -r` 会跳过它——CI/部署行为与并入源码前一致。

## 已并入的源码（`src/` + 构建配置）

- `src/`：上游完整源码，**排除 `src/templates/defaults/curated-backgrounds/`**（约 28M 模板背景母图）。
  - 这些母图是 staticUrl 运行时外链（模板里以 `/chinese-masonry-assets/curated-backgrounds/*` 字符串引用，不参与 build），其运行时副本已在 `apps/web/public/chinese-masonry-assets/curated-backgrounds/`。
  - 如需 build-from-source 后重新生成模板母图，从上游 `<上游本地仓库>/chinese-masonry` 取。
- 保留了被代码 `import` 的资源目录：`src/templates/defaults/generated-assets/`、`generated-assets-v2/`。
- 构建配置：`tsconfig.json` / `tsconfig.build.json` / `vite.config.ts` / `tailwind.config.js` / `postcss.config.js` / `eslint.config.js` / `vitest.config.ts`。

## 将来切 build-from-source（待办）

1. 把上游 `package.json` 的 `devDependencies` 与 `scripts`（`build` = `tsc -p tsconfig.build.json && vite build`、`typecheck`、`test`）并入本包 `package.json`。
2. 验证 `pnpm -r build` / `pnpm -r typecheck` 全绿、版本与根冲突可解。
3. 视情况移除已提交的 `dist/`，改为构建产出。

## 上游

源码来源：本机 `<上游本地仓库>/chinese-masonry`（独立 git 仓库，无 remote）。本次为内容拷贝并入，未保留上游提交历史。
