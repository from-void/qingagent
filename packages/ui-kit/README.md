# @qingagent/ui-kit

`@qingagent/ui-kit` 是青简设计 token 与基础样式的唯一来源，不是完整的 React 组件库。

## 包含内容

- `tokens.css`：暖纸、金、墨色、字体等设计 token。
- `base.css`：全局重置、页面基础规则与字体工具类。
- `components.css`：应用直接复用的组件样式与 `wf-*` 类。
- `Button`、`Chip`、`Modal`、`Input`：4 个已经被产品消费的原始 React 组件。

直接导入包入口会按顺序注入全部样式，并可同时使用已有组件：

```tsx
import "@qingagent/ui-kit";
import { Button, Modal } from "@qingagent/ui-kit";
```

需要自行控制加载顺序时，可分别使用 CSS 子路径：

```ts
import "@qingagent/ui-kit/tokens.css";
import "@qingagent/ui-kit/base.css";
import "@qingagent/ui-kit/components.css";
```

## 边界

这个包不打算成长为组件全家桶。应用层的主要复用单元是“裸 HTML 元素 + CSS 类 + token”；不要为了形式上的“统一”把现有 471 处裸 `button`、58 处裸 `input` 机械迁成 React 组件。这类改造收益低、评审风险高，且在本仓库已经多次验证不可取。

只有同时满足以下条件的新组件才应进入 `ui-kit`：

- 至少在 3 处真实的跨页面场景中复用；
- 样式与交互已经稳定。

不满足判据的组件留在使用处；共享视觉规则优先沉淀为现有 token 或 CSS 类。
