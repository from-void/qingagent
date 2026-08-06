export function replacementCharRatio(text: string): number {
  let replacementCount = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0xfffd) replacementCount += 1;
  }
  return replacementCount / Math.max(text.length, 1);
}
