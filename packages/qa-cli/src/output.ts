import { QaCliError } from "./errors.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function optionValues(
  args: string[],
  name: string,
  arity: number,
  options?: {
    knownOptionNames: ReadonlySet<string>;
    missingMessage: string;
  },
): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== name) continue;
    const values = args.slice(i + 1, i + 1 + arity);
    const missingValue = values.length !== arity ||
      values.some((value) => options?.knownOptionNames.has(value));
    if (missingValue) {
      throw new QaCliError(
        "VALIDATION",
        options?.missingMessage ?? `${name} 缺少参数`,
      );
    }
    out.push(values);
  }
  return out;
}
