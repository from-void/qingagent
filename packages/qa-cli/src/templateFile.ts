import { readFile, writeFile } from "node:fs/promises";
import { QaCliError } from "./errors.js";
import type {
  ExternalReviewTemplate,
  ExternalReviewType,
} from "./generated/externalApi.js";

export interface TemplateMarkdown {
  filePath: string;
  id?: string;
  type: ExternalReviewType;
  name: string;
  updatedAt?: string;
  prompt: string;
}

const REVIEW_TYPES = new Set<ExternalReviewType>([
  "sensitive", "deai", "source", "consistency",
  "privacy", "format", "role", "custom",
]);

export async function readTemplateMarkdown(filePath: string): Promise<TemplateMarkdown> {
  const source = await readFile(filePath, "utf8");
  const match = source.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new QaCliError("VALIDATION", "模板文件缺少 frontmatter");
  const metadata = parseFlatFrontmatter(match[1]!);
  const type = metadata.type;
  const name = metadata.name?.trim();
  const prompt = source.replace(/^\uFEFF/, "").slice(match[0].length).trim();
  if (!isReviewType(type) || !name || !prompt) {
    throw new QaCliError("VALIDATION", "模板文件的 type、name 或正文不合法");
  }
  const id = metadata.id?.trim();
  const updatedAt = metadata.updatedAt?.trim();
  if (id && !updatedAt) {
    throw new QaCliError("VALIDATION", "带 id 的模板文件必须包含 updatedAt");
  }
  return {
    filePath,
    ...(id ? { id } : {}),
    type,
    name,
    ...(updatedAt ? { updatedAt } : {}),
    prompt,
  };
}

export async function writeTemplateMarkdown(
  filePath: string,
  template: ExternalReviewTemplate,
): Promise<void> {
  const source = [
    "---",
    `id: ${yamlString(template.id)}`,
    `type: ${template.type}`,
    `name: ${yamlString(template.name)}`,
    `updatedAt: ${yamlString(template.updatedAt)}`,
    "---",
    template.prompt.trim(),
    "",
  ].join("\n");
  await writeFile(filePath, source, "utf8");
}

function parseFlatFrontmatter(block: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!match) continue;
    output[match[1]!] = unquote(match[2]!);
  }
  return output;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function yamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isReviewType(value: string | undefined): value is ExternalReviewType {
  return value !== undefined && REVIEW_TYPES.has(value as ExternalReviewType);
}
