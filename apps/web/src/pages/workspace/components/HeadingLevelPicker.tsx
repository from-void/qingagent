// 标题层级选择器:文档工具栏的标题下拉、块手柄的「转换为」面板共用同一组件与同一套 class,
// 六级(H1~H6)排成**紧凑一行**,不再是六行长列表,各面板样式与排布一致。
import type { ReactNode } from "react";

export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];

const HEADING_LEVEL_CN = ["一", "二", "三", "四", "五", "六"] as const;

/** 「三级标题」这类中文名,供 aria-label / title / toast 复用。 */
export function headingLevelLabel(level: HeadingLevel): string {
  return `${HEADING_LEVEL_CN[level - 1]}级标题`;
}

export function HeadingLevelPicker({
  onPick,
  isDisabled,
  activeLevel = null,
  titleOf,
  footer,
  itemRole,
}: {
  onPick: (level: HeadingLevel) => void;
  /** 逐级禁用判定(如工具栏解锁门控);不给则全部可用。 */
  isDisabled?: (level: HeadingLevel) => boolean;
  activeLevel?: number | null;
  /** 自定义 title(用于附带快捷键提示)。 */
  titleOf?: (level: HeadingLevel) => string;
  /** 行尾附加按钮(如「正文」),与六级同排。 */
  footer?: ReactNode;
  /**
   * 菜单里的角色。文档工具栏下拉用方向键在 .dt-mi 行间漫游,横排六格不参与那条纵向漫游,
   * 故默认不挂 menuitem;块手柄的图标网格本就是 menuitem 网格,由调用方显式传入。
   */
  itemRole?: "menuitem";
}) {
  return (
    <div className="wf-hlevels" role="group" aria-label="标题层级">
      {HEADING_LEVELS.map((level) => {
        const label = headingLevelLabel(level);
        const disabled = isDisabled?.(level) ?? false;
        return (
          <button
            key={level}
            type="button"
            role={itemRole}
            className={`wf-hlevel${activeLevel === level ? " is-active" : ""}`}
            aria-label={label}
            title={titleOf?.(level) ?? label}
            disabled={disabled}
            // 不抢焦点:正文选区必须保住,命令才作用在原处。
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!disabled) onPick(level);
            }}
          >
            H{level}
          </button>
        );
      })}
      {footer}
    </div>
  );
}
