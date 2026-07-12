export { isTruthyFlag } from "@qingagent/doc-render/browser";
import { isTruthyFlag } from "@qingagent/doc-render/browser";

export function isServerReanchorEnabled(): boolean {
  // PR0 server-side reanchor is a safety-gated cheap win. Default off; only an
  // explicit truthy env var enables fuzzy before-anchor relocation.
  return isTruthyFlag(process.env.QINGAGENT_SERVER_REANCHOR);
}
