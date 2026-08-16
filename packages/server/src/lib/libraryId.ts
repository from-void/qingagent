const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 启动锁与实例发现可在数据库模块加载前复用的纯身份校验。 */
export function isValidLibraryId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
