# chinese-masonry

中国风瀑布流 React 组件库。卡片宽度固定为 `290px`，内置 65 套模板，并提供可视化模板编辑器。

## 特性

- `ChineseMasonry`：固定 290px 卡片宽度，最少 3 列，容器宽度始终是完整列宽倍数。
- `CardRenderer`：按模板 JSON 渲染文字、图片、装饰线条和水墨色彩层。
- `TemplateRegistry`：模板注册、查询、分类查询、懒加载与移除。
- `createTemplateSelector`：按文章图片、标题语言、标题长度、分类和标签选择模板。
- `TemplateEditor`：可编辑现有模板，也能新建模板；支持卡片高度、圆角、背景色、全局字体、图片来源、上传图片、文字排版、撤销重做、JSON 面板。
- Demo：默认 250 条示例内容，包含瀑布流预览和模板编辑器两个 Tab。
- 生成素材：62 套生成模板使用裁切后的独立图片素材，包含横图、竖图、窄栏图、照片感器物、斜切构图和纯白纸面。

## 安装

```bash
npm install chinese-masonry
```

## 基础用法

```tsx
import {
  ChineseMasonry,
  TemplateRegistry,
  defaultTemplates,
  type ArticleData,
} from 'chinese-masonry';
import 'chinese-masonry/style.css';

const articles: ArticleData[] = [
  {
    id: '1',
    title: '春江花月夜',
    description: '春江潮水连海平，海上明月共潮生。',
    imageUrl: 'https://example.com/image.jpg',
  },
];

const registry = new TemplateRegistry();
defaultTemplates.forEach((template) => registry.register(template));

export function App() {
  return (
    <ChineseMasonry
      items={articles}
      registry={registry}
      fontConfig={{
        titleFont: 'Georgia, "Noto Serif SC", STKaiti, KaiTi, serif',
        descriptionFont: 'Inter, "Noto Sans SC", "Microsoft YaHei", sans-serif',
      }}
      colorConfig={{
        enabled: true,
        grayscale: 0.55,
        sepia: 0.28,
        overlayColor: 'rgba(102, 151, 142, 0.28)',
        textColor: '#183244',
        lineColor: 'rgba(24, 50, 68, 0.48)',
      }}
    />
  );
}
```

## 模板编辑器

```tsx
import { TemplateEditor, defaultTemplates } from 'chinese-masonry';

export function Editor() {
  return (
    <TemplateEditor
      initialTemplate={defaultTemplates[0]}
      onSave={(template) => {
        // 在应用里把 template 注册回 TemplateRegistry 即可立即预览。
      }}
    />
  );
}
```

Demo 里的编辑器流程：

1. 在“正在编辑”里选择内置模板。
2. 调整卡片、文字、图片或线条。
3. 点“保存模板”。
4. 回到“瀑布流预览”，保存后的模板会自动成为当前预览模板。
5. 需要把模板变成库内置模板时，用 JSON 面板内容同步到 `src/templates/defaults/*.json`。

## 开发

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
npm run demo:dev
```

## 公共 API

| 导出名 | 类型 | 说明 |
| --- | --- | --- |
| `ChineseMasonry` | React Component | 瀑布流主组件 |
| `TemplateEditor` | React Component | 可视化模板编辑器 |
| `CardRenderer` | React Component | 单张卡片渲染器 |
| `TemplateRegistry` | class | 模板注册管理 |
| `createTemplateSelector` | function | 创建模板选择器 |
| `defaultTemplates` | constant | 内置模板集合 |
| `CARD_WIDTH` | constant | 固定卡片宽度，值为 `290` |

## 核心类型

- `ArticleData`
- `TemplateDefinition`
- `TemplateElement`
- `TextElement`
- `ImageElement`
- `LineElement`
- `TemplateMeta`
- `GlobalFontConfig`
- `MasonryColorConfig`
- `ChineseMasonryProps`
- `SelectorOptions`
