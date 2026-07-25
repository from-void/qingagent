# draw.io 图表规范

<!-- diagram-viz:drawio:start -->

## QingML 包装

- 文档中的工程图必须写成 `<drawio>转义后的 mxGraphModel XML</drawio>`，不要套 Markdown fence，也不要放进 `<pre>`。
- `<drawio>` 正文中的 XML `<` 与 `&` 必须分别写成 `&lt;` 与 `&amp;`；磁盘范本和编辑器里的 source 保持未转义明文 XML。
- source 是唯一语义真相源。编辑时保留未改节点、容器、边的稳定 `mxCell id`，不要整体重编号。

## XML 形状纪律（从主 system 原文迁移）

- 工程图/架构图 diagram(drawio)：当用户需要网络拓扑、部署图、系统架构、工程框图、容器分组、精确坐标或复杂连线时，用 <drawio>；普通流程/时序/状态/思维导图仍优先用更简洁的 Mermaid。drawio source 是唯一语义真相源，必须是**未压缩明文** mxGraph XML，严禁 base64、deflate 或只给压缩 mxfile；编辑时直接修改 XML，并保留未改节点/边的稳定 mxCell id。最小合法形状必须有 <mxGraphModel><root>、id="0" 根单元、id="1" parent="0" 图层；节点是 vertex="1" 的 mxCell 且带含 x/y/width/height 的 mxGeometry；边是 edge="1" 的 mxCell，带 source/target，并有 relative="1" 的 mxGeometry。QingML 内所有 XML < 和 & 必须转义。可直接照此最小范本扩写：<drawio>&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id="0"/&gt;&lt;mxCell id="1" parent="0"/&gt;&lt;mxCell id="service-a" value="服务 A" style="rounded=0;whiteSpace=wrap;html=0;" vertex="1" parent="1"&gt;&lt;mxGeometry x="40" y="40" width="120" height="60" as="geometry"/&gt;&lt;/mxCell&gt;&lt;mxCell id="service-b" value="服务 B" style="rounded=0;whiteSpace=wrap;html=0;" vertex="1" parent="1"&gt;&lt;mxGeometry x="240" y="40" width="120" height="60" as="geometry"/&gt;&lt;/mxCell&gt;&lt;mxCell id="edge-1" edge="1" parent="1" source="service-a" target="service-b"&gt;&lt;mxGeometry relative="1" as="geometry"/&gt;&lt;/mxCell&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;</drawio>。不要在 XML 中放 script、链接、外部图片或可执行 HTML；svg 不用填，客户端离线渲染并安全加固后缓存。

## 样式串与布局网格

- 颜色值必须写成明文 `#RRGGBB`，禁止 URL/百分号编码（例如用 `%23` 代替 `#`）。
  - ✅ 正确：`fillColor=#EDF2F7;strokeColor=#4A6FA5;fontColor=#1F2329;`
  - ❌ 错误：`fillColor=%23EDF2F7;strokeColor=%234A6FA5;fontColor=%231F2329;`

节点样式基式：

```text
rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#FFFFFF;strokeColor=<组色>;strokeWidth=2;fontColor=<正文色>;fontSize=14;spacing=8;
```

容器样式基式：

```text
rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=<组浅色>;strokeColor=<组深色>;strokeWidth=2;dashed=1;fontColor=<正文色>;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;
```

边样式基式：

```text
edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;strokeColor=<连线灰>;strokeWidth=2;labelBackgroundColor=#FFFFFF;fontColor=<辅助文字色>;fontSize=13;exitX=1;exitY=0.5;entryX=0;entryY=0.5;
```

带标签的边必须用偏移，避免文字压住节点或线：

```xml
<mxGeometry relative="1" as="geometry">
  <mxPoint x="0" y="-12" as="offset"/>
</mxGeometry>
```

- 坐标和尺寸取 20 的倍数；标准节点 `160×60`。
- 相邻节点留至少 40；同层节点中心间距至少 220（即 160 宽 + 60 空隙）。
- 层间距至少 120；容器内边距至少 40，标题区预留 60。
- 边必须是正交线。需要改变路径时使用明确 waypoint，不靠随意弯曲或彩色边区分类别。
- 完整色板样式串见 `palettes.md`；分层架构范本见 `templates.md`。

<!-- diagram-viz:drawio:end -->
