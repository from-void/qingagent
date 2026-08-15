import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(packageDir, "../..");
const sourcePath = resolve(packageDir, "src/ExternalApi.ts");
const targetPath = resolve(repoDir, "packages/qa-cli/src/generated/externalApi.ts");
const packageJson = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
const source = await readFile(sourcePath, "utf8");
// ExternalApi 在契约源内直接复用正式 BridgeFrame/DocDiffReady/PmDoc；qa-cli 的
// 生成副本把这些纯类型 import 指向工作区包，编译后不会留下运行期依赖。
const generatedSource = source.replace(
  /from "\.\/(?:BridgeFrame|DocDiffReady|PmDoc)";/g,
  'from "@qingagent/contract-ts";',
);
const generated = `// 生成物勿手改：由 @qingagent/contract-ts 生成。\n// 源：packages/contract-ts/src/ExternalApi.ts（contract-ts@${packageJson.version}）\n\n${generatedSource}`;

if (process.argv.includes("--check")) {
  const current = await readFile(targetPath, "utf8").catch(() => "");
  if (current !== generated) {
    console.error("external API 生成类型已漂移；请运行 pnpm external-contract:generate");
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, generated);
}
