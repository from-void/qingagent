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

export function optionValues(args: string[], name: string, arity: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== name) continue;
    const values = args.slice(i + 1, i + 1 + arity);
    if (values.length === arity) out.push(values);
  }
  return out;
}
