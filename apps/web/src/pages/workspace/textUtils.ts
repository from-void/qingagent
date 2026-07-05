/**
 * Truncate a label string to max characters for chip display.
 * Shows first 3 + ellipsis + last 3 characters when the text exceeds
 * the threshold.
 */
export function truncateLabel(text: string, max = 7): string {
  const raw = text.replace(/^"|"$/g, "");
  if (raw.length <= max) return raw;
  const edge = Math.floor(max / 2);
  return `${raw.slice(0, edge)}…${raw.slice(-edge)}`;
}
