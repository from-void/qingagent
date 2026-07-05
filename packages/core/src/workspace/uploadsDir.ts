import path from "node:path";

/**
 * 上传文件落盘根目录的统一解析(canonical)。
 *
 * 默认 cwd 下 `./uploads`(web/VPS 行为不变);桌面端打包后 cwd 常不可写,故由
 * `QINGAGENT_UPLOADS_DIR` 覆盖指向 userData。server 写、core 多处读,必须解析到同一目录,
 * 所以集中在此。各处在模块求值期 `const X = uploadsBaseDir()` 取值——桌面主进程在 import
 * server/core 之前已设好该环境变量。
 *
 * 注意:server 的 uploadStorage.ts 因避免引入 core 整桶 import 边(有副作用、有顺序风险),
 * 内联同一行逻辑并注释指向本函数。改默认/变量名时两处同步。
 */
export function uploadsBaseDir(): string {
  const override = process.env.QINGAGENT_UPLOADS_DIR?.trim();
  return override ? path.resolve(override) : path.resolve("./uploads");
}
