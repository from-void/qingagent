function stableStringify(value: unknown): string {
  // 对齐 JSON.stringify 的容器语义：对象属性中的非 JSON 值会被省略，
  // 数组槽位中的非 JSON 值写为 null。根值也收敛为 null，保证公开 API 始终返回合法 JSON。
  if (
    value === undefined
    || typeof value === "function"
    || typeof value === "symbol"
  ) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${Array.from(value, (item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => {
      const child = record[key];
      return child !== undefined
        && typeof child !== "function"
        && typeof child !== "symbol";
    })
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function fnv1a(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function getStablePmJson(value: unknown): string {
  return stableStringify(value);
}

export function getDeterministicId(prefix: string, value: unknown): string {
  const stable = stableStringify(value);
  return `${prefix}-${fnv1a(stable, 0x811c9dc5)}${fnv1a(stable, 0x9e3779b9)}`;
}

export function getPmContentHash(value: unknown): string {
  const stable = stableStringify(value);
  const parts = [
    fnv1a(stable, 0x811c9dc5),
    fnv1a(stable, 0x9e3779b9),
    fnv1a(stable, 0x85ebca6b),
    fnv1a(stable, 0xc2b2ae35),
  ];
  return `pmv1-${parts.join("")}`;
}
