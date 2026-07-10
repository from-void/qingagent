import { join, resolve } from "node:path";

/** 运行时数据根目录。Electron 主进程应设为 app.getPath("userData")/data;
 *  server/dev 默认 .qingagent/data。绝不能落在 ./uploads(公开文件服务根)下。 */
export const QINGAGENT_DATA_DIR = process.env.QINGAGENT_DATA_DIR
  ? resolve(process.env.QINGAGENT_DATA_DIR)
  : resolve(".qingagent/data");

/** 会话沙箱工作目录根。 */
export const SANDBOX_SESSIONS_BASE = process.env.QINGAGENT_SANDBOX_DIR
  ? resolve(process.env.QINGAGENT_SANDBOX_DIR)
  : join(QINGAGENT_DATA_DIR, "sessions");

/** 产品级 CLI 安装目录(lark-cli 等官方 CLI 装这里,所有会话沙箱共享一份)。 */
export const SANDBOX_BIN_DIR = process.env.QINGAGENT_SANDBOX_BIN_DIR
  ? resolve(process.env.QINGAGENT_SANDBOX_BIN_DIR)
  : join(QINGAGENT_DATA_DIR, "bin");
