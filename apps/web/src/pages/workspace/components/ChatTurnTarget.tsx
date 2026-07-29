export function ChatTurnTarget({ label }: { label: string }) {
  return (
    <div
      className="ws-chat-target"
      data-wf="ChatTurnTarget"
      role="status"
      aria-live="polite"
      title={`当前指令作用于：${label}`}
    >
      <span>指令目标</span>
      <strong>{label}</strong>
    </div>
  );
}
