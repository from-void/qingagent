import { Hono } from "hono";
import {
  deleteInstalledSkill,
  getSerializedSkill,
  installSkillFiles,
  isSkillMutationAllowed,
  listSerializedSkills,
  replaceInstalledSkillFiles,
  setSkillEnabledByName,
} from "./skills";
import { externalError } from "../lib/externalError";

export const externalSkillRoutes = new Hono();

externalSkillRoutes.get("/skills", async (c) => {
  const startedAt = Date.now();
  try {
    const skills = await listSerializedSkills(false);
    logSkillRequest(c.req.header("x-qa-client"), "skills_list", startedAt, "ok");
    return c.json({ skills });
  } catch {
    logSkillRequest(c.req.header("x-qa-client"), "skills_list", startedAt, "failed");
    return c.json({ skills: [] });
  }
});

externalSkillRoutes.get("/skills/:name", async (c) => {
  const startedAt = Date.now();
  const skill = await getSerializedSkill(c.req.param("name"), true).catch(() => null);
  if (!skill) {
    logSkillRequest(c.req.header("x-qa-client"), "skills_show", startedAt, "rejected:NOT_FOUND");
    return externalError(c, 404, "NOT_FOUND", "技能不存在");
  }
  logSkillRequest(c.req.header("x-qa-client"), "skills_show", startedAt, "ok");
  return c.json({ skill });
});

externalSkillRoutes.post("/skills", async (c) => {
  const startedAt = Date.now();
  if (!isSkillMutationAllowed()) {
    logSkillRequest(c.req.header("x-qa-client"), "skills_install", startedAt, "rejected:GATE");
    return externalError(c, 403, "VALIDATION", "当前环境已禁止安装技能");
  }
  const body = await c.req.json().catch(() => null) as {
    skillMd?: unknown;
    files?: unknown;
  } | null;
  const files = skillFilesFromBody(body);
  if (!files.ok) {
    logSkillRequest(c.req.header("x-qa-client"), "skills_install", startedAt, "rejected:VALIDATION");
    return externalError(c, 400, "VALIDATION", files.message);
  }
  try {
    const result = await installSkillFiles(files.value);
    logSkillRequest(c.req.header("x-qa-client"), "skills_install", startedAt, "installed");
    return c.json({ installed: true as const, name: result.name });
  } catch (error) {
    return skillMutationError(c, error, "skills_install", startedAt);
  }
});

externalSkillRoutes.put("/skills/:name", async (c) => {
  const startedAt = Date.now();
  if (!isSkillMutationAllowed()) {
    logSkillRequest(c.req.header("x-qa-client"), "skills_update", startedAt, "rejected:GATE");
    return externalError(c, 403, "VALIDATION", "当前环境已禁止修改技能");
  }
  const body = await c.req.json().catch(() => null) as {
    skillMd?: unknown;
    files?: unknown;
  } | null;
  const files = skillFilesFromBody(body);
  if (!files.ok) {
    logSkillRequest(c.req.header("x-qa-client"), "skills_update", startedAt, "rejected:VALIDATION");
    return externalError(c, 400, "VALIDATION", files.message);
  }
  try {
    const result = await replaceInstalledSkillFiles(c.req.param("name"), files.value);
    logSkillRequest(c.req.header("x-qa-client"), "skills_update", startedAt, "updated");
    return c.json({ updated: true as const, name: result.name });
  } catch (error) {
    return skillMutationError(c, error, "skills_update", startedAt);
  }
});

externalSkillRoutes.delete("/skills/:name", async (c) => {
  const startedAt = Date.now();
  if (!isSkillMutationAllowed()) {
    logSkillRequest(c.req.header("x-qa-client"), "skills_delete", startedAt, "rejected:GATE");
    return externalError(c, 403, "VALIDATION", "当前环境已禁止删除技能");
  }
  try {
    const deleted = await deleteInstalledSkill(c.req.param("name"));
    if (!deleted) {
      logSkillRequest(c.req.header("x-qa-client"), "skills_delete", startedAt, "rejected:NOT_FOUND");
      return externalError(c, 404, "NOT_FOUND", "技能不存在");
    }
    logSkillRequest(c.req.header("x-qa-client"), "skills_delete", startedAt, "deleted");
    return c.json({ deleted: true as const, name: c.req.param("name") });
  } catch (error) {
    return skillMutationError(c, error, "skills_delete", startedAt);
  }
});

externalSkillRoutes.post("/skills/:name/:action", async (c) => {
  const startedAt = Date.now();
  const action = c.req.param("action");
  if (action !== "enable" && action !== "disable") {
    return externalError(c, 404, "NOT_FOUND");
  }
  const enabled = action === "enable";
  const changed = await setSkillEnabledByName(c.req.param("name"), enabled)
    .catch(() => false);
  if (!changed) {
    logSkillRequest(c.req.header("x-qa-client"), "skills_toggle", startedAt, "rejected:NOT_FOUND");
    return externalError(c, 404, "NOT_FOUND", "技能不存在");
  }
  logSkillRequest(c.req.header("x-qa-client"), "skills_toggle", startedAt, action);
  return c.json({ name: c.req.param("name"), enabled });
});

function skillFilesFromBody(
  body: { skillMd?: unknown; files?: unknown } | null,
):
  | { ok: true; value: unknown }
  | { ok: false; message: string } {
  const hasSkillMd = typeof body?.skillMd === "string";
  const hasFiles = Array.isArray(body?.files);
  if ((hasSkillMd ? 1 : 0) + (hasFiles ? 1 : 0) !== 1) {
    return { ok: false, message: "请求体必须且只能包含 skillMd 或 files" };
  }
  return {
    ok: true,
    value: hasSkillMd
      ? [{ path: "SKILL.md", content: body!.skillMd }]
      : body!.files,
  };
}

function skillMutationError(
  c: Parameters<typeof externalError>[0],
  error: unknown,
  evt: string,
  startedAt: number,
) {
  const message = error instanceof Error ? error.message : "技能操作失败";
  if (message === "not found") {
    logSkillRequest(c.req.header("x-qa-client"), evt, startedAt, "rejected:NOT_FOUND");
    return externalError(c, 404, "NOT_FOUND", "技能不存在");
  }
  if (
    message === "skill already exists" ||
    message === "builtin skill is read only"
  ) {
    logSkillRequest(c.req.header("x-qa-client"), evt, startedAt, "rejected:CONFLICT");
    return externalError(
      c,
      409,
      "CONFLICT",
      message === "skill already exists" ? "这个技能已存在" : "内置技能不能修改或删除",
    );
  }
  logSkillRequest(c.req.header("x-qa-client"), evt, startedAt, "rejected:VALIDATION");
  return externalError(c, 400, "VALIDATION", message);
}

function logSkillRequest(
  client: string | undefined,
  evt: string,
  startedAt: number,
  result: string,
): void {
  const safeClient = client === "claudecode" || client === "codex" ? client : "agent";
  console.log(
    `[external] evt=${evt} client=${safeClient} ms=${Date.now() - startedAt} result=${result}`,
  );
}
