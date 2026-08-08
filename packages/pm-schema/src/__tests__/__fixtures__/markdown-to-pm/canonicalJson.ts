function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, sortJsonKeys(record[key])]),
  );
}

/** Golden 的唯一序列化口径：递归键排序后交给 JSON.stringify。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonKeys(value));
}
