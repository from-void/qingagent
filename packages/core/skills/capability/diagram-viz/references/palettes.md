# 图表色板

所有色板都遵守：容器浅填充加深描边、组内节点白底加组色 2px 描边、连线统一专属灰、强调色不超过 10%。下面 Mermaid 范本中的 `classDef` / `class` / `subgraph` 配方以 flowchart 为适用范围；stateDiagram-v2 复用时须遵守母技能的 ASCII 状态 ID 规则，classDiagram 与其他图型禁止机械套用。flowchart / stateDiagram-v2 每图最多四个语义 `classDef`；适用图型中的每个节点都必须挂到某个 `classDef` 类（用 `class` 语句逐节点点名），未挂类节点会吃主题默认底色、破坏整板。init 的 `clusterBkg` / `clusterBorder` 是全图分区默认色；不同分区需要不同颜色时，为每个 `subgraph` 使用稳定 ASCII id，并写 `style 分区id fill:#浅色,stroke:#深色`，可附加画布已保真支持的 `color`、`stroke-width`；不要附加 `stroke-dasharray`、节点几何或字号属性。draw.io 样式串必须完整复制，不能遗漏安全的 `html=0`、边框、字号与边标签白底。

## Token 总表

| 预设 | 组色（浅色 / 深色） | 正文 | 辅助 | 强调 | 连线 |
|---|---|---|---|---|---|
| 青简纸墨（默认） | 纸 `#FAF6EC` / 墨 `#2F2A22`；深纸 `#EFE7D6` / 金铜 `#A8823F` | `#2F2A22` | `#8A7F6E` | `#A8823F` | `#B3A791` |
| 经典 | 蓝 `#F0F4FC/#5178C6`；紫 `#EAE2FE/#8569CB`；绿 `#DFF5E5/#509863`；黄 `#FEF1CE/#D4B45B`；红 `#FEE3E2/#D25D5A` | `#1F2329` | `#646A73` | `#1F2329` | `#BBBFC4` |
| 商务 | `#EDF2F7/#4A6FA5`；`#D4E0ED/#4A6FA5`；`#E8EDF3/#5A7B9A`；`#F0F0F0/#8895A7` | `#1F2329` | `#5E6C7B` | `#2D4A7A` | `#718BAE` |
| 极简 | `#F8F9FA/#DEE2E6`；`#E9ECEF/#ADB5BD`；`#FFFFFF/#CED4DA`；`#F1F3F5/#868E96` | `#343A40` | `#6C757D` | `#495057` | `#ADB5BD` |
| 手绘水墨 | 底 `#E8E4D6` / 墨绿 `#192B1B`；白 `#FFFFFF` / 赤陶 `#C8524A` | `#192B1B` | `#657064` | `#C8524A` | `#8E9588` |

<!-- diagram-viz:palettes:mermaid:start -->

## Mermaid 映射

### 青简纸墨

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'#FAF6EC','primaryColor':'#FFFFFF','primaryBorderColor':'#2F2A22','primaryTextColor':'#2F2A22','secondaryColor':'#FFFFFF','secondaryBorderColor':'#A8823F','tertiaryColor':'#EFE7D6','tertiaryBorderColor':'#2F2A22','mainBkg':'#FFFFFF','nodeBorder':'#2F2A22','clusterBkg':'#EFE7D6','clusterBorder':'#2F2A22','lineColor':'#B3A791','edgeLabelBackground':'#FFFFFF','textColor':'#2F2A22','fontSize':'14px'}}}%%
flowchart LR
  classDef ink fill:#FFFFFF,stroke:#2F2A22,stroke-width:2px,color:#2F2A22,rx:8px,ry:8px
  classDef gold fill:#FFFFFF,stroke:#A8823F,stroke-width:2px,color:#2F2A22,rx:8px,ry:8px
  classDef emphasis fill:#FFFFFF,stroke:#A8823F,stroke-width:3px,color:#2F2A22,rx:8px,ry:8px
```

### 经典

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'#FFFFFF','primaryColor':'#FFFFFF','primaryBorderColor':'#5178C6','primaryTextColor':'#1F2329','mainBkg':'#FFFFFF','nodeBorder':'#5178C6','clusterBkg':'#F0F4FC','clusterBorder':'#5178C6','lineColor':'#BBBFC4','edgeLabelBackground':'#FFFFFF','textColor':'#1F2329','fontSize':'14px'}}}%%
flowchart LR
  classDef blue fill:#FFFFFF,stroke:#5178C6,stroke-width:2px,color:#1F2329,rx:8px,ry:8px
  classDef purple fill:#FFFFFF,stroke:#8569CB,stroke-width:2px,color:#1F2329,rx:8px,ry:8px
  classDef green fill:#FFFFFF,stroke:#509863,stroke-width:2px,color:#1F2329,rx:8px,ry:8px
  classDef yellow fill:#FFFFFF,stroke:#D4B45B,stroke-width:2px,color:#1F2329,rx:8px,ry:8px
  classDef red fill:#FFFFFF,stroke:#D25D5A,stroke-width:2px,color:#1F2329,rx:8px,ry:8px
```

容器分别使用对应浅色 `#F0F4FC/#EAE2FE/#DFF5E5/#FEF1CE/#FEE3E2` 填充与深色描边；一张图最多选其中四组。

### 商务

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'#FFFFFF','primaryColor':'#FFFFFF','primaryBorderColor':'#4A6FA5','primaryTextColor':'#1F2329','mainBkg':'#FFFFFF','nodeBorder':'#4A6FA5','clusterBkg':'#EDF2F7','clusterBorder':'#4A6FA5','lineColor':'#718BAE','edgeLabelBackground':'#FFFFFF','textColor':'#1F2329','fontSize':'14px'}}}%%
flowchart LR
  classDef zone fill:#FFFFFF,stroke:#4A6FA5,stroke-width:2px,color:#1F2329,rx:8px,ry:8px
  classDef team fill:#FFFFFF,stroke:#5A7B9A,stroke-width:2px,color:#1F2329,rx:8px,ry:8px
  classDef support fill:#FFFFFF,stroke:#8895A7,stroke-width:2px,color:#1F2329,rx:8px,ry:8px
  classDef emphasis fill:#FFFFFF,stroke:#2D4A7A,stroke-width:3px,color:#1F2329,rx:8px,ry:8px
```

容器浅填充依次用 `#EDF2F7/#D4E0ED/#E8EDF3/#F0F0F0`。

### 极简

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'#FFFFFF','primaryColor':'#FFFFFF','primaryBorderColor':'#868E96','primaryTextColor':'#343A40','mainBkg':'#FFFFFF','nodeBorder':'#ADB5BD','clusterBkg':'#F8F9FA','clusterBorder':'#DEE2E6','lineColor':'#ADB5BD','edgeLabelBackground':'#FFFFFF','textColor':'#343A40','fontSize':'14px'}}}%%
flowchart LR
  classDef light fill:#FFFFFF,stroke:#DEE2E6,stroke-width:2px,color:#343A40,rx:8px,ry:8px
  classDef medium fill:#FFFFFF,stroke:#ADB5BD,stroke-width:2px,color:#343A40,rx:8px,ry:8px
  classDef dark fill:#FFFFFF,stroke:#868E96,stroke-width:2px,color:#343A40,rx:8px,ry:8px
  classDef emphasis fill:#FFFFFF,stroke:#495057,stroke-width:3px,color:#343A40,rx:8px,ry:8px
```

### 手绘水墨

```mermaid
---
config:
  look: handDrawn
  theme: base
  themeVariables:
    background: "#E8E4D6"
    primaryColor: "#FFFFFF"
    primaryBorderColor: "#192B1B"
    primaryTextColor: "#192B1B"
    mainBkg: "#FFFFFF"
    nodeBorder: "#192B1B"
    clusterBkg: "#E8E4D6"
    clusterBorder: "#192B1B"
    lineColor: "#8E9588"
    edgeLabelBackground: "#FFFFFF"
    fontSize: "14px"
---
flowchart LR
  classDef grove fill:#FFFFFF,stroke:#192B1B,stroke-width:2px,color:#192B1B
  classDef clay fill:#FFFFFF,stroke:#C8524A,stroke-width:2px,color:#192B1B
  classDef emphasis fill:#FFFFFF,stroke:#C8524A,stroke-width:3px,color:#192B1B
```

<!-- diagram-viz:palettes:mermaid:end -->

<!-- diagram-viz:palettes:drawio:start -->

## draw.io 映射

以下每套都给出 `节点 / 容器 / 边` 完整 style 串。节点组色可替换为同板其他深色，容器浅/深色必须成对；边色不可替换成组色。

### 青简纸墨

```text
节点：rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#FFFFFF;strokeColor=#2F2A22;strokeWidth=2;fontColor=#2F2A22;fontSize=14;spacing=8;
容器：rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#EFE7D6;strokeColor=#2F2A22;strokeWidth=2;dashed=1;fontColor=#2F2A22;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;
边：edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;strokeColor=#B3A791;strokeWidth=2;labelBackgroundColor=#FFFFFF;fontColor=#8A7F6E;fontSize=13;exitX=1;exitY=0.5;entryX=0;entryY=0.5;
强调节点：rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#FFFFFF;strokeColor=#A8823F;strokeWidth=3;fontColor=#2F2A22;fontSize=14;spacing=8;
```

### 经典

```text
蓝组节点：rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#FFFFFF;strokeColor=#5178C6;strokeWidth=2;fontColor=#1F2329;fontSize=14;spacing=8;
蓝组容器：rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#F0F4FC;strokeColor=#5178C6;strokeWidth=2;dashed=1;fontColor=#1F2329;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;
边：edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;strokeColor=#BBBFC4;strokeWidth=2;labelBackgroundColor=#FFFFFF;fontColor=#646A73;fontSize=13;exitX=1;exitY=0.5;entryX=0;entryY=0.5;
强调节点：rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#FFFFFF;strokeColor=#1F2329;strokeWidth=3;fontColor=#1F2329;fontSize=14;spacing=8;
```

其他组把浅色/深色成对替换为紫 `#EAE2FE/#8569CB`、绿 `#DFF5E5/#509863`、黄 `#FEF1CE/#D4B45B`、红 `#FEE3E2/#D25D5A`。

### 商务

```text
节点：rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#FFFFFF;strokeColor=#4A6FA5;strokeWidth=2;fontColor=#1F2329;fontSize=14;spacing=8;
容器：rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#EDF2F7;strokeColor=#4A6FA5;strokeWidth=2;dashed=1;fontColor=#1F2329;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;
边：edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;strokeColor=#718BAE;strokeWidth=2;labelBackgroundColor=#FFFFFF;fontColor=#5E6C7B;fontSize=13;exitX=1;exitY=0.5;entryX=0;entryY=0.5;
强调节点：rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#FFFFFF;strokeColor=#2D4A7A;strokeWidth=3;fontColor=#1F2329;fontSize=14;spacing=8;
```

其他组使用 `#D4E0ED/#4A6FA5`、`#E8EDF3/#5A7B9A`、`#F0F0F0/#8895A7`。

### 极简

```text
节点：rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#FFFFFF;strokeColor=#868E96;strokeWidth=2;fontColor=#343A40;fontSize=14;spacing=8;
容器：rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#F8F9FA;strokeColor=#DEE2E6;strokeWidth=2;dashed=1;fontColor=#343A40;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;
边：edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;strokeColor=#ADB5BD;strokeWidth=2;labelBackgroundColor=#FFFFFF;fontColor=#6C757D;fontSize=13;exitX=1;exitY=0.5;entryX=0;entryY=0.5;
强调节点：rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#FFFFFF;strokeColor=#495057;strokeWidth=3;fontColor=#343A40;fontSize=14;spacing=8;
```

其他组使用 `#E9ECEF/#ADB5BD`、`#FFFFFF/#CED4DA`、`#F1F3F5/#868E96`。

### 手绘水墨

```text
节点：rounded=1;arcSize=8;whiteSpace=wrap;html=0;sketch=1;curveFitting=1;fillColor=#FFFFFF;strokeColor=#192B1B;strokeWidth=2;fontColor=#192B1B;fontSize=14;spacing=8;
容器：rounded=1;arcSize=8;whiteSpace=wrap;html=0;sketch=1;curveFitting=1;fillColor=#E8E4D6;strokeColor=#192B1B;strokeWidth=2;dashed=1;fontColor=#192B1B;fontSize=24;fontStyle=1;verticalAlign=top;spacingTop=12;
边：edgeStyle=orthogonalEdgeStyle;rounded=1;endArrow=block;sketch=1;curveFitting=1;strokeColor=#8E9588;strokeWidth=2;labelBackgroundColor=#FFFFFF;fontColor=#657064;fontSize=13;exitX=1;exitY=0.5;entryX=0;entryY=0.5;
强调节点：rounded=1;arcSize=8;whiteSpace=wrap;html=0;sketch=1;curveFitting=1;fillColor=#FFFFFF;strokeColor=#C8524A;strokeWidth=3;fontColor=#192B1B;fontSize=14;spacing=8;
```

所有带标签的边都使用：

```xml
<mxGeometry relative="1" as="geometry">
  <mxPoint x="0" y="-12" as="offset"/>
</mxGeometry>
```

<!-- diagram-viz:palettes:drawio:end -->
