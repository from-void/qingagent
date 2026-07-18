import { resolve } from "node:path";

type EvalOutputDirOptions = {
  envName: string;
  scriptName: string;
};

/** Resolve an evaluation artifact directory without exposing a machine-local path. */
export function resolveEvalOutputDir({ envName, scriptName }: EvalOutputDirOptions): string {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`用法: ${scriptName} [--out-dir <目录>]\n\n也可通过 ${envName} 指定输出目录；默认写入 .eval-out/。`);
    process.exit(0);
  }

  let argumentDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--out-dir") {
      argumentDir = args[index + 1];
      if (!argumentDir || argumentDir.startsWith("-")) {
        throw new Error("--out-dir 必须带目录参数；可运行 --help 查看用法。");
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--out-dir=")) {
      argumentDir = argument.slice("--out-dir=".length);
      if (!argumentDir) throw new Error("--out-dir 必须带目录参数；可运行 --help 查看用法。");
      continue;
    }
    throw new Error(`未知参数: ${argument}；可运行 --help 查看用法。`);
  }

  return resolve(argumentDir ?? process.env[envName] ?? ".eval-out");
}
