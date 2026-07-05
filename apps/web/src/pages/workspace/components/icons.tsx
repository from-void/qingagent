// 工作区共用图标(描线 SVG,随 currentColor 着色)。

/** 对勾:替代各处的 ✓ 符号/emoji。描线收笔,水墨描线风。 */
export function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "inline-block", verticalAlign: "-0.14em", flexShrink: 0 }}
    >
      <path d="M4.5 12.8l4.6 4.7L19.5 6.6" />
    </svg>
  );
}

/** 向下箭头:用于聊天区回到底部按钮。 */
export function ArrowDownIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: "inline-block", verticalAlign: "-0.14em", flexShrink: 0 }}
    >
      <path d="M12 5v14" />
      <path d="m6.5 13.5 5.5 5.5 5.5-5.5" />
    </svg>
  );
}
