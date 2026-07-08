import { Agent, setGlobalDispatcher } from "undici";

/** 全局出网连接池换成长 keep-alive(undici 默认 ~4s,两轮对话之间连接必断,
 *  每轮都要重付 DNS+TCP+TLS;拉到 60s 后对话内多轮复用同一条连接)。
 *  undici 的 setGlobalDispatcher 用 Symbol.for 全局注册表,对 Node 内建 fetch 同样生效。
 *  desktop 主进程无 undici 直接依赖且 esbuild 整包 bundle,必须经本模块(随 server 依赖树
 *  静态解析)间接取用,不可在 desktop 里 createRequire("undici")——打包态解析不到。 */
export function installLongKeepAliveDispatcher(): void {
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 120_000 }));
}
