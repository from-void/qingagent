import type { Client } from "@libsql/client";

export interface Migration {
  /** 迁移号：1, 2, 3, ... 必须与注册表下标 +1 一致。 */
  id: number;
  name: string;
  up: (client: Client) => Promise<void>;
}
