import type { z } from "zod";

export interface SvgTemplate<P> {
  id: string;
  label: string;
  paramsSchema: z.ZodType<P>;
  render(params: P, opts: { width: number; height: number }): string;
}
