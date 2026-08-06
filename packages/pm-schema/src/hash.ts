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

function replaceBareUndefinedTokens(
  input: string,
  replacement: string,
): { json: string; replacements: number } | null {
  let json = "";
  let inString = false;
  let replacements = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (inString) {
      json += char;
      if (char === "\\") {
        index += 1;
        if (index < input.length) json += input[index]!;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      json += char;
      continue;
    }
    if (!input.startsWith("undefined", index)) {
      json += char;
      continue;
    }

    let previousIndex = index - 1;
    while (previousIndex >= 0 && /\s/.test(input[previousIndex]!)) previousIndex -= 1;
    let nextIndex = index + "undefined".length;
    while (nextIndex < input.length && /\s/.test(input[nextIndex]!)) nextIndex += 1;
    const previous = input[previousIndex];
    const next = input[nextIndex];
    if (
      previous !== ":"
      && previous !== "["
      && previous !== ","
    ) {
      json += char;
      continue;
    }
    if (next !== "," && next !== "}" && next !== "]") {
      json += char;
      continue;
    }

    json += replacement;
    replacements += 1;
    index += "undefined".length - 1;
  }

  return replacements > 0 ? { json, replacements } : null;
}

function countSentinel(value: unknown, sentinel: string): number {
  if (value === sentinel) return 1;
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countSentinel(item, sentinel), 0);
  }
  if (value === null || typeof value !== "object") return 0;
  return Object.values(value).reduce(
    (count, item) => count + countSentinel(item, sentinel),
    0,
  );
}

function restoreUndefinedSemantics(value: unknown, sentinel: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === sentinel ? null : restoreUndefinedSemantics(item, sentinel)
    );
  }
  if (value === null || typeof value !== "object") return value;
  const restored: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === sentinel) continue;
    restored[key] = restoreUndefinedSemantics(item, sentinel);
  }
  return restored;
}

/**
 * 修复旧 stableStringify 写出的裸 undefined。只接受“替换后整体可被 JSON.parse”
 * 的输入；围栏、前后散文、截断或其他损坏一律返回 null，交由隔离机制保留。
 */
export function repairLegacyStableJsonUndefined(input: string): unknown | null {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    // 候选哨兵若也存在于用户字符串中，计数会大于裸 token 数，换下一个即可；
    // 因此不会误删正文里转义得到的同名字符串。
    const sentinel = `\u0000qingagent-stable-undefined-${attempt}\u0000`;
    const replaced = replaceBareUndefinedTokens(input, JSON.stringify(sentinel));
    if (!replaced) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(replaced.json) as unknown;
    } catch {
      return null;
    }
    if (countSentinel(parsed, sentinel) !== replaced.replacements) continue;
    return restoreUndefinedSemantics(parsed, sentinel);
  }
  return null;
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
