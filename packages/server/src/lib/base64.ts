function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

/**
 * 严格解码 canonical base64。校验必须保持线性扫描，不能对几十 MiB 的字符串使用
 * 带重复分组的整体正则，否则 V8 的正则回溯栈会在合法上传上溢出。
 */
export function decodeBase64(content: string): Buffer | null {
  const length = content.length;
  if (length % 4 !== 0) return null;

  let padding = 0;
  if (length > 0 && content.charCodeAt(length - 1) === 61) padding += 1;
  if (length > 1 && content.charCodeAt(length - 2) === 61) padding += 1;
  const dataLength = length - padding;
  if (
    (padding > 0 && length < 4) ||
    (padding === 1 && dataLength % 4 !== 3) ||
    (padding === 2 && dataLength % 4 !== 2)
  ) {
    return null;
  }

  let finalValue = 0;
  for (let index = 0; index < dataLength; index += 1) {
    const value = base64Value(content.charCodeAt(index));
    if (value < 0) return null;
    finalValue = value;
  }
  for (let index = dataLength; index < length; index += 1) {
    if (content.charCodeAt(index) !== 61) return null;
  }

  // 被 padding 舍弃的低位必须为 0；否则 Buffer.from 会宽松解码非 canonical 输入。
  if ((padding === 2 && (finalValue & 0x0f) !== 0) ||
      (padding === 1 && (finalValue & 0x03) !== 0)) {
    return null;
  }

  const expectedBytes = (length / 4) * 3 - padding;
  const buffer = Buffer.from(content, "base64");
  return buffer.byteLength === expectedBytes ? buffer : null;
}
