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

/**
 * 输入框文件 chip 使用中间省略，确保尾部扩展名始终可见。
 * Array.from 按 Unicode 字符而非 UTF-16 code unit 截取，中文和 emoji 不会按字节处理。
 */
export function truncateFilenameMiddle(filename: string, max = 20, minTail = 8): string {
  const chars = Array.from(filename);
  if (chars.length <= max) return filename;

  const dotIndex = filename.lastIndexOf(".");
  const extensionLength = dotIndex > 0 ? Array.from(filename.slice(dotIndex)).length : 0;
  const tailLength = Math.max(minTail, extensionLength);
  const headLength = Math.max(1, max - tailLength - 1);

  return `${chars.slice(0, headLength).join("")}…${chars.slice(-tailLength).join("")}`;
}
