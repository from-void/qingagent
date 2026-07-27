import { Hono } from "hono";
import JSZip from "jszip";
import type { JSZipObject } from "jszip";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import {
  BUILTIN_SKILLS_DIR,
  SKILLS_INSTALL_DIR,
  USER_SKILLS_DIR,
  ARCHIVED_BUILTIN_SKILLS,
  getQingagentSkills,
  listChildSkills,
  listTopLevelSkills,
  parseSkillFrontmatter,
  readDisabledSet,
  setEnabled,
  listConnectorDefinitions,
} from "@qingagent/core";
import type { ParsedSkillFrontmatter } from "@qingagent/core";
import { requireTrustedOrigin } from "../lib/trustedOrigin";

export type SkillSourceLabel = "builtin" | "installed";
export interface SkillFileInput {
  path: string;
  content: string;
}

export interface SkillMarkdownInstallOperations {
  mkdtemp: typeof mkdtemp;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
}

const defaultSkillMarkdownInstallOperations: SkillMarkdownInstallOperations = {
  mkdtemp,
  rename,
  rm,
  writeFile,
};

export interface SkillListItem extends ParsedSkillFrontmatter {
  path: string;
  source: SkillSourceLabel;
  enabled: boolean;
  mtimeMs: number;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_ZIP_ENTRIES = 200;
const MAX_UNZIPPED_BYTES = 10 * 1024 * 1024;
const MAX_LABEL_LENGTH = 256;
const BUILTIN_SKILL_ORDER = [
  "browser-ops",
  "web-search",
  "image-gen",
  "image-reading",
  "doc-calc",
  "materials",
  "github-materials",
  "feishu",
  "wechat-official-account",
] as const;

export { parseSkillFrontmatter };

export const skillsRoutes = new Hono();

export function connectorIdForSkill(skillName: string): string | undefined {
  return listConnectorDefinitions().find((connector) =>
    connector.usedBySkills.includes(skillName),
  )?.id;
}

// 技能"安装/删除/上传"= 把任意可执行代码写进服务器,是 RCE 面。
// 安全默认:默认关闭,仅显式真值(1/true/yes/on)才放开;桌面主进程显式置 1。
// 启用/禁用(enable/disable)只动开关不写代码,不受本 gate 约束,始终放行。
const MUTATION_ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
export function isSkillMutationAllowed(): boolean {
  const raw = process.env.QINGAGENT_ALLOW_SKILL_MUTATION;
  if (raw === undefined) return false;
  return MUTATION_ENABLED_VALUES.has(raw.trim().toLowerCase());
}

skillsRoutes.get("/skills", async (c) => {
  try {
    const skills = await getQingagentSkills();
    await skills.maybeRefresh().catch(() => undefined);
    await skills.list().catch(() => []);
  } catch {
    return c.json({ skills: [] });
  }

  const disabled = await readDisabledSet();
  const skills = await listAllSkillItems(disabled);
  return c.json({
    skills: await Promise.all(skills.map((skill) => serializeSkillListItem(skill))),
  });
});

skillsRoutes.get("/skills/:name", async (c) => {
  const name = c.req.param("name");
  if (!isValidSkillName(name)) return c.json({ error: "not found" }, 404);
  const skill = await findSkillOnDisk(name);
  if (!skill) return c.json({ error: "not found" }, 404);
  const childName = c.req.query("child");
  if (childName !== undefined) {
    if (!isValidSkillName(childName)) return c.json({ error: "not found" }, 404);
    const children = await listChildSkills(skill.path).catch(() => []);
    // 子技能路径只取自技能发现结果，绝不以请求参数拼接磁盘路径。
    const child = children.find((item) => item.metadata.name === childName);
    if (!child) return c.json({ error: "not found" }, 404);
    try {
      const skillMd = await readFile(join(child.path, "SKILL.md"), "utf8");
      return c.json({
        name: child.metadata.name,
        description: child.metadata.description,
        label: child.metadata.label,
        summary: child.metadata.summary,
        icon: child.metadata.icon,
        source: skill.source,
        userInvocable: child.metadata.userInvocableExplicit
          ? child.metadata.userInvocable
          : skill.source === "installed",
        placeholder: child.metadata.placeholder,
        config: child.metadata.config,
        tools: child.metadata.tools,
        enabled: skill.enabled,
        connectorId: connectorIdForSkill(child.metadata.name),
        body: stripSkillFrontmatter(skillMd),
      });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  }
  try {
    const skillMd = await readFile(join(skill.path, "SKILL.md"), "utf8");
    return c.json({
      name: skill.name,
      description: skill.description,
      label: skill.label,
      summary: skill.summary,
      icon: skill.icon,
      source: skill.source,
      userInvocable: skill.userInvocable,
      placeholder: skill.placeholder,
      config: skill.config,
      tools: skill.tools,
      enabled: skill.enabled,
      connectorId: connectorIdForSkill(skill.name),
      body: stripSkillFrontmatter(skillMd),
    });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

skillsRoutes.post("/skills/install", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  if (!isSkillMutationAllowed()) {
    return c.json({ error: "当前环境已禁止安装技能（仅管理员可在部署层开启）" }, 403);
  }
  try {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) {
        return c.json({ error: "请选择技能安装包" }, 400);
      }
      const { name } = await installZip(Buffer.from(await file.arrayBuffer()));
      await refreshSkills();
      return c.json({ installed: true, name });
    }

    const body: { name?: string; skillMd?: string } = await c.req
      .json<{ name?: string; skillMd?: string }>()
      .catch(() => ({}));
    if (!body.skillMd) {
      return c.json({ error: "SKILL.md missing valid frontmatter" }, 400);
    }
    // 名称以 SKILL.md frontmatter 为唯一真源(parseSkillFrontmatter 已校验 name 合法 + description 非空)。
    // body.name 可选,仅作可选的一致性校验——前端不必再自行解析取名(避免前后端校验口径漂移)。
    const parsed = parseSkillFrontmatter(body.skillMd);
    if (!parsed) {
      return c.json({ error: "SKILL.md missing valid frontmatter" }, 400);
    }
    const provided = body.name?.trim();
    if (provided && provided !== parsed.name) {
      return c.json({ error: "技能名称与 SKILL.md 不一致" }, 400);
    }
    const name = parsed.name;

    const dest = resolve(SKILLS_INSTALL_DIR, name);
    if (!isInside(resolve(SKILLS_INSTALL_DIR), dest)) return c.json({ error: "技能名称不合法" }, 400);
    if (existsSync(dest)) return c.json({ error: "这个技能已存在" }, 409);
    // Archived built-ins are hidden from list/detail, but their names remain reserved
    // while the built-in directories still exist in the repo.
    if (isReservedSkillName(name)) return c.json({ error: "这个技能已存在" }, 409);
    // Reject names that collide with any existing skill, including built-ins,
    // to avoid shadowing/duplicate-name ambiguity in skill resolution.
    if (await findSkillOnDisk(name)) return c.json({ error: "这个技能已存在" }, 409);

    await installSkillFiles([{ path: "SKILL.md", content: body.skillMd }]);
    await refreshSkills();
    return c.json({ installed: true, name });
  } catch (error) {
    const message = error instanceof Error ? error.message : "install failed";
    const status = message === "skill already exists" ? 409 : 400;
    return c.json({ error: status === 409 ? "这个技能已存在" : message }, status);
  }
});

skillsRoutes.post("/skills/:name/:action", async (c) => {
  const name = c.req.param("name");
  const action = c.req.param("action");
  if (action !== "enable" && action !== "disable") {
    return c.json({ error: "not found" }, 404);
  }

  try {
    const exists = await skillExists(name);
    if (!exists) return c.json({ error: "not found" }, 404);
    await setEnabled(name, action === "enable");
    await refreshSkills();
    return c.json({ name, enabled: action === "enable" });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

skillsRoutes.patch("/skills/:name", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  if (!isSkillMutationAllowed()) {
    return c.json({ error: "当前环境已禁止修改技能（仅管理员可在部署层开启）" }, 403);
  }

  const name = c.req.param("name");
  if (!isValidSkillName(name)) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { label?: unknown };
  const labelResult = normalizeSkillLabel(body.label);
  if (!labelResult.ok) return c.json({ error: labelResult.error }, 400);

  try {
    const skill = await findSkillOnDisk(name);
    if (!skill) return c.json({ error: "not found" }, 404);
    if (skill.source !== "installed") {
      return c.json({ error: "内置技能不能修改显示名" }, 400);
    }

    const skillMdPath = join(skill.path, "SKILL.md");
    const skillMd = await readFile(skillMdPath, "utf8");
    const updated = setSkillLabelInMarkdown(skillMd, labelResult.label);
    await writeFile(skillMdPath, updated, "utf8");
    await refreshSkills();
    return c.json({ name, label: labelResult.label });
  } catch (error) {
    const message = error instanceof Error ? error.message : "update failed";
    return c.json({ error: message }, 500);
  }
});

skillsRoutes.delete("/skills/:name", async (c) => {
  const rejected = requireTrustedOrigin(c);
  if (rejected) return rejected;

  if (!isSkillMutationAllowed()) {
    return c.json({ error: "当前环境已禁止删除技能（仅管理员可在部署层开启）" }, 403);
  }
  const name = c.req.param("name");
  try {
    const skill = await findSkillOnDisk(name);
    if (!skill) return c.json({ error: "not found" }, 404);
    if (skill.source !== "installed") {
      return c.json({ error: "内置技能不能删除" }, 400);
    }
    await rm(skill.path, { recursive: true, force: true });
    await refreshSkills();
    return c.json({ deleted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "delete failed";
    return c.json({ error: message }, 500);
  }
});

export async function refreshSkills(): Promise<void> {
  try {
    const skills = await getQingagentSkills();
    await skills.refresh();
  } catch {
    // Routes remain usable even when the agent workspace is unavailable.
  }
}

async function installZip(buffer: Buffer): Promise<{ name: string }> {
  const zip = await JSZip.loadAsync(buffer);
  const files: JSZipObject[] = Object.values(zip.files).filter(
    (entry): entry is JSZipObject => !entry.dir,
  );
  if (files.length === 0 || files.length > MAX_ZIP_ENTRIES) {
    throw new Error("invalid zip file");
  }

  const skillMdCandidates: string[] = [];
  for (const entry of files) {
    const safe = sanitizeZipPath(entry.name);
    const parts = safe.split("/");
    if (parts.at(-1) === "SKILL.md" && parts.length <= 2) {
      skillMdCandidates.push(safe);
    }
  }
  // 裸根包优先认根 SKILL.md；带一层 ZIP 包装目录时只允许一个候选根。
  // 子技能 child/SKILL.md 在裸根包里不能反客为主覆盖母技能。
  const skillMdPath = skillMdCandidates.includes("SKILL.md")
    ? "SKILL.md"
    : skillMdCandidates.length === 1
      ? skillMdCandidates[0]!
      : null;
  if (!skillMdPath) throw new Error("zip missing SKILL.md");

  const skillEntry = zip.file(skillMdPath);
  const skillMdBytes = skillEntry
    ? await readZipEntryBounded(skillEntry, MAX_UNZIPPED_BYTES)
    : null;
  const skillMd = skillMdBytes?.toString("utf8");
  const parsed = skillMd ? parseSkillFrontmatter(skillMd) : null;
  if (!parsed) throw new Error("SKILL.md missing valid frontmatter");

  const dest = resolve(SKILLS_INSTALL_DIR, parsed.name);
  if (!isInside(resolve(SKILLS_INSTALL_DIR), dest)) throw new Error("invalid skill name");
  if (existsSync(dest)) throw new Error("skill already exists");
  if (isReservedSkillName(parsed.name)) throw new Error("skill already exists");
  // Reject names that collide with any existing skill, including built-ins.
  if (await findSkillOnDisk(parsed.name)) throw new Error("skill already exists");

  const rootPrefix = skillMdPath.includes("/") ? `${skillMdPath.split("/")[0]}/` : "";
  const entries: Array<{ entry: JSZipObject; destRel: string }> = [];
  for (const entry of files) {
    const safe = sanitizeZipPath(entry.name);
    const destRel = rootPrefix && safe.startsWith(rootPrefix) ? safe.slice(rootPrefix.length) : safe;
    if (!destRel) continue;
    const outPath = resolve(dest, destRel);
    if (!isInside(dest, outPath)) throw new Error("invalid zip path");
    entries.push({ entry, destRel });
  }

  await mkdir(SKILLS_INSTALL_DIR, { recursive: true });
  const staging = await mkdtemp(join(SKILLS_INSTALL_DIR, ".install-"));
  let totalBytes = 0;
  try {
    for (const item of entries) {
      const outPath = resolve(staging, item.destRel);
      if (!isInside(staging, outPath)) throw new Error("invalid zip path");
      await mkdir(dirname(outPath), { recursive: true });
      const file = await open(outPath, "wx");
      try {
        await consumeZipEntry(item.entry, async (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_UNZIPPED_BYTES) {
            throw new Error("zip is too large");
          }
          await writeAll(file, chunk);
        });
      } finally {
        await file.close();
      }
    }
    await rename(staging, dest);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { name: parsed.name };
}

async function readZipEntryBounded(entry: JSZipObject, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  await consumeZipEntry(entry, (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new Error("zip is too large");
    }
    chunks.push(chunk);
  });
  return Buffer.concat(chunks, totalBytes);
}

function consumeZipEntry(
  entry: JSZipObject,
  onChunk: (chunk: Buffer) => void | Promise<void>,
): Promise<void> {
  return new Promise<void>((resolveStream, rejectStream) => {
    const stream = entry.nodeStream("nodebuffer");
    let settled = false;
    let processing = Promise.resolve();
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.pause();
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      rejectStream(error);
    };

    stream
      .on("data", (rawChunk: Buffer) => {
        if (settled) return;
        stream.pause();
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        processing = processing
          .then(() => onChunk(chunk))
          .then(() => {
            if (!settled) stream.resume();
          })
          .catch(fail);
      })
      .on("error", fail)
      .on("end", () => {
        void processing.then(() => {
          if (settled) return;
          settled = true;
          resolveStream();
        }, fail);
      })
      .resume();
  });
}

async function writeAll(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(
      chunk,
      offset,
      chunk.length - offset,
    );
    if (bytesWritten <= 0) throw new Error("zip write failed");
    offset += bytesWritten;
  }
}

export async function installSkillMarkdown(
  dest: string,
  skillMd: string,
  operations: SkillMarkdownInstallOperations = defaultSkillMarkdownInstallOperations,
): Promise<void> {
  await mkdir(SKILLS_INSTALL_DIR, { recursive: true });
  const staging = await operations.mkdtemp(join(SKILLS_INSTALL_DIR, ".install-"));
  try {
    await operations.writeFile(join(staging, "SKILL.md"), skillMd, "utf8");
    await operations.rename(staging, dest);
  } catch (error) {
    await operations.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (isDestinationExistsError(error)) throw new Error("skill already exists");
    throw error;
  }
}

/**
 * JSON 技能安装与更新共用的文件级校验。只接受普通相对路径，
 * 不允许调用方通过绝对路径、盘符或 `..` 逃出 staging。
 */
export function validateSkillFiles(input: unknown): {
  files: SkillFileInput[];
  root: ParsedSkillFrontmatter;
} {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ZIP_ENTRIES) {
    throw new Error("files 必须是非空数组");
  }
  const files: SkillFileInput[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const value of input) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { path?: unknown }).path !== "string" ||
      typeof (value as { content?: unknown }).content !== "string"
    ) {
      throw new Error("files.path/content 不合法");
    }
    const path = sanitizeSkillPath((value as { path: string }).path);
    if (seen.has(path)) throw new Error(`技能文件路径重复: ${path}`);
    seen.add(path);
    const content = (value as { content: string }).content;
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > MAX_UNZIPPED_BYTES) throw new Error("skill files are too large");
    files.push({ path, content });
  }
  const rootSource = files.find((file) => file.path === "SKILL.md")?.content;
  const root = rootSource ? parseSkillFrontmatter(rootSource) : null;
  if (!root) throw new Error("SKILL.md missing valid frontmatter");
  for (const file of files) {
    if (file.path !== "SKILL.md" && file.path.endsWith("/SKILL.md")) {
      if (!parseSkillFrontmatter(file.content)) {
        throw new Error(`${file.path} missing valid frontmatter`);
      }
    }
  }
  return { files, root };
}

export async function installSkillFiles(
  input: unknown,
): Promise<{ name: string }> {
  const validated = validateSkillFiles(input);
  const name = validated.root.name;
  const dest = resolve(SKILLS_INSTALL_DIR, name);
  if (!isInside(resolve(SKILLS_INSTALL_DIR), dest)) throw new Error("invalid skill name");
  if (existsSync(dest) || isReservedSkillName(name) || await findSkillOnDisk(name)) {
    throw new Error("skill already exists");
  }
  await writeSkillFilesToNewDestination(dest, validated.files);
  await refreshSkills();
  return { name };
}

export async function replaceInstalledSkillFiles(
  name: string,
  input: unknown,
): Promise<{ name: string }> {
  if (!isValidSkillName(name)) throw new Error("not found");
  const skill = await findSkillOnDisk(name);
  if (!skill) throw new Error("not found");
  if (skill.source !== "installed") throw new Error("builtin skill is read only");

  const validated = validateSkillFiles(input);
  if (validated.root.name !== name) throw new Error("技能名称与路径参数不一致");

  await mkdir(SKILLS_INSTALL_DIR, { recursive: true });
  const staging = await mkdtemp(join(SKILLS_INSTALL_DIR, ".update-"));
  const backup = `${skill.path}.backup-${randomSuffix()}`;
  try {
    await writeSkillFilesInto(staging, validated.files);
    await rename(skill.path, backup);
    try {
      await rename(staging, skill.path);
    } catch (error) {
      await rename(backup, skill.path).catch(() => undefined);
      throw error;
    }
    try {
      await rm(backup, { recursive: true, force: true });
    } catch (cleanupError) {
      // 备份清理也属于整体替换的一部分：清理失败就把旧版换回，
      // 避免磁盘上同时出现两个同名可发现技能。
      const failedNew = `${skill.path}.failed-${randomSuffix()}`;
      await rename(skill.path, failedNew);
      try {
        await rename(backup, skill.path);
      } catch (restoreError) {
        await rename(failedNew, skill.path).catch(() => undefined);
        throw restoreError;
      }
      await rm(failedNew, { recursive: true, force: true }).catch(() => undefined);
      throw cleanupError;
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (existsSync(backup) && !existsSync(skill.path)) {
      await rename(backup, skill.path).catch(() => undefined);
    }
    throw error;
  }
  await refreshSkills();
  return { name };
}

export async function deleteInstalledSkill(name: string): Promise<boolean> {
  if (!isValidSkillName(name)) return false;
  const skill = await findSkillOnDisk(name);
  if (!skill) return false;
  if (skill.source !== "installed") throw new Error("builtin skill is read only");
  await rm(skill.path, { recursive: true, force: true });
  await refreshSkills();
  return true;
}

export async function setSkillEnabledByName(
  name: string,
  enabled: boolean,
): Promise<boolean> {
  if (!await skillExists(name)) return false;
  await setEnabled(name, enabled);
  await refreshSkills();
  return true;
}

export async function listSerializedSkills(
  includeBody = false,
): Promise<Array<Record<string, unknown>>> {
  const disabled = await readDisabledSet();
  const skills = await listAllSkillItems(disabled);
  return Promise.all(skills.map((skill) => serializeSkillListItem(skill, includeBody)));
}

export async function getSerializedSkill(
  name: string,
  includeBody = true,
): Promise<Record<string, unknown> | null> {
  if (!isValidSkillName(name)) return null;
  const skill = await findSkillOnDisk(name);
  return skill ? serializeSkillListItem(skill, includeBody) : null;
}

async function writeSkillFilesToNewDestination(
  dest: string,
  files: readonly SkillFileInput[],
): Promise<void> {
  await mkdir(SKILLS_INSTALL_DIR, { recursive: true });
  const staging = await mkdtemp(join(SKILLS_INSTALL_DIR, ".install-"));
  try {
    await writeSkillFilesInto(staging, files);
    await rename(staging, dest);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (isDestinationExistsError(error)) throw new Error("skill already exists");
    throw error;
  }
}

async function writeSkillFilesInto(
  root: string,
  files: readonly SkillFileInput[],
): Promise<void> {
  for (const file of files) {
    const outputPath = resolve(root, file.path);
    if (!isInside(root, outputPath)) throw new Error("invalid skill path");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, file.content, { encoding: "utf8", flag: "wx" });
  }
}

function sanitizeSkillPath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const rawParts = slashed.split("/");
  if (
    !slashed ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    rawParts.some((part) => part === ".." || part === "" || part === ".")
  ) {
    throw new Error("invalid skill path");
  }
  const normalized = normalize(slashed).replace(/\\/g, "/");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    throw new Error("invalid skill path");
  }
  return normalized;
}

function randomSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isDestinationExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}

function sanitizeZipPath(path: string): string {
  const normalized = normalize(path.replace(/\\/g, "/"));
  const parts = normalized.split("/");
  if (
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    normalized === "." ||
    parts.includes("..")
  ) {
    throw new Error("invalid zip path");
  }
  return normalized.replace(/\\/g, "/");
}

export function stripSkillFrontmatter(source: string): string {
  return source.replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function isValidSkillName(name: string): boolean {
  return NAME_RE.test(name);
}

export function isReservedSkillName(name: string): boolean {
  return ARCHIVED_BUILTIN_SKILLS.has(name);
}

export async function listAllSkillItems(disabled: Set<string>): Promise<SkillListItem[]> {
  const dirs = await collectAllSkillDirs();
  const items: SkillListItem[] = [];
  for (const { path, source, mtimeMs } of dirs) {
    try {
      const skillMd = await readFile(join(path, "SKILL.md"), "utf8");
      const parsed = parseSkillFrontmatter(skillMd);
      if (!parsed) continue;
      items.push({
        ...parsed,
        userInvocable: parsed.userInvocableExplicit ? parsed.userInvocable : source === "installed",
        path,
        source,
        enabled: !disabled.has(parsed.name),
        mtimeMs,
      });
    } catch {
      // Ignore malformed or concurrently removed skill directories.
    }
  }
  return items.sort(compareSkillItems);
}

export async function serializeSkillListItem(
  skill: SkillListItem,
  includeBody = false,
): Promise<Record<string, unknown>> {
  const discoveredChildren = await listChildSkills(skill.path).catch(() => []);
  const children = discoveredChildren.map<SkillListItem>((child) => ({
    ...child.metadata,
    userInvocable: child.metadata.userInvocableExplicit
      ? child.metadata.userInvocable
      : skill.source === "installed",
    path: child.path,
    source: skill.source,
    // 子技能不提供独立开关，enabled 始终继承母技能的总控状态。
    enabled: skill.enabled,
    mtimeMs: child.mtimeMs,
  }));

  const body = includeBody
    ? stripSkillFrontmatter(await readFile(join(skill.path, "SKILL.md"), "utf8"))
    : undefined;
  return {
    name: skill.name,
    description: skill.description,
    label: skill.label,
    summary: skill.summary,
    icon: skill.icon,
    source: skill.source,
    userInvocable: skill.userInvocable,
    placeholder: skill.placeholder,
    config: skill.config,
    tools: skill.tools,
    enabled: skill.enabled,
    connectorId: connectorIdForSkill(skill.name),
    ...(body !== undefined ? { body } : {}),
    children: await Promise.all(children.map((child) =>
      serializeSkillListItem(child, includeBody)
    )),
  };
}

export async function skillExists(name: string): Promise<boolean> {
  if (ARCHIVED_BUILTIN_SKILLS.has(name)) return false;
  try {
    const skills = await getQingagentSkills();
    if (await skills.has(name).catch(() => false)) return true;
  } catch {
    // Fall through to disk scan.
  }
  return (await findSkillOnDisk(name)) !== null;
}

export async function findSkillOnDisk(name: string): Promise<SkillListItem | null> {
  const disabled = await readDisabledSet();
  return (await listAllSkillItems(disabled)).find((skill) => skill.name === name) ?? null;
}

async function collectAllSkillDirs(): Promise<Array<{ path: string; source: SkillSourceLabel; mtimeMs: number }>> {
  const roots: Array<{ path: string; source: SkillSourceLabel }> = [
    { path: join(BUILTIN_SKILLS_DIR, "capability"), source: "builtin" },
    { path: join(BUILTIN_SKILLS_DIR, "native"), source: "builtin" },
    { path: join(BUILTIN_SKILLS_DIR, "style"), source: "builtin" },
    { path: USER_SKILLS_DIR, source: "installed" },
  ];
  const result: Array<{ path: string; source: SkillSourceLabel; mtimeMs: number }> = [];
  for (const root of roots) {
    try {
      const skills = await listTopLevelSkills(root.path);
      for (const skill of skills) {
        if (root.source === "builtin" && ARCHIVED_BUILTIN_SKILLS.has(skill.metadata.name)) continue;
        result.push({
          path: skill.path,
          source: root.source,
          mtimeMs: skill.mtimeMs,
        });
      }
    } catch {
      // Missing user install dir is normal.
    }
  }
  return result;
}

function compareSkillItems(a: SkillListItem, b: SkillListItem): number {
  if (a.source !== b.source) return a.source === "builtin" ? -1 : 1;
  if (a.source === "builtin") {
    const ai = builtinOrder(a.name);
    const bi = builtinOrder(b.name);
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  }
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
  return a.name.localeCompare(b.name);
}

function builtinOrder(name: string): number {
  const index = BUILTIN_SKILL_ORDER.indexOf(name as (typeof BUILTIN_SKILL_ORDER)[number]);
  return index === -1 ? BUILTIN_SKILL_ORDER.length : index;
}

export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeSkillLabel(value: unknown): { ok: true; label: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: "显示名不能为空" };
  const label = value.trim();
  if (!label) return { ok: false, error: "显示名不能为空" };
  if (/[\r\n]/.test(label)) return { ok: false, error: "显示名不能换行" };
  if (Array.from(label).length > MAX_LABEL_LENGTH) {
    return { ok: false, error: `显示名不能超过 ${MAX_LABEL_LENGTH} 个字符` };
  }
  return { ok: true, label };
}

function setSkillLabelInMarkdown(source: string, label: string): string {
  const hasBom = source.startsWith("\uFEFF");
  const body = hasBom ? source.slice(1) : source;
  const match = body.match(/^---(\r?\n)([\s\S]*?)(\r?\n)---/);
  if (!match || match.index !== 0) throw new Error("SKILL.md missing valid frontmatter");

  const newline = match[1]!;
  const block = match[2]!;
  const lines = block.split(/\r?\n/);
  const labelLine = `label: ${formatFrontmatterString(label)}`;
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (/^label\s*:/.test(line)) {
      replaced = true;
      return labelLine;
    }
    return line;
  });
  if (!replaced) {
    const nameIndex = nextLines.findIndex((line) => /^name\s*:/.test(line));
    nextLines.splice(nameIndex >= 0 ? nameIndex + 1 : 0, 0, labelLine);
  }

  const head = `---${newline}${nextLines.join(newline)}${match[3]}---`;
  return `${hasBom ? "\uFEFF" : ""}${head}${body.slice(match[0].length)}`;
}

function formatFrontmatterString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
