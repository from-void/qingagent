export function SupplementField(props: {
  value: string;
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="ws-launch-field ws-launch-supplement">
      <span>补充要求</span>
      <textarea
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </label>
  );
}
