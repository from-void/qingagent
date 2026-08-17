import { Hono } from "hono";
import { z } from "zod";
import {
  COACH_MARK_IDS,
  type CoachMarkId,
  type OnboardingSettingsResponse,
  type OnboardingState,
  type UpdateOnboardingStateResponse,
} from "@qingagent/contract-ts";
import {
  getAppSetting,
  setAppSetting,
  SETTING_ONBOARDING_STATE,
} from "@qingagent/db";
import { requireTrustedOrigin } from "../lib/trustedOrigin";

const updateStateSchema = z.object({
  status: z.enum(["done", "skipped"]),
}).strict();
const coachIds = new Set<string>(COACH_MARK_IDS);

interface OnboardingSettingsDependencies {
  getSetting?: (key: string) => Promise<string | null>;
  setSetting?: (key: string, value: string) => Promise<void>;
  now?: () => Date;
}

function coachSettingKey(id: CoachMarkId): string {
  return `coach_seen:${id}`;
}

function parseState(raw: string | null): OnboardingState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    if (
      (parsed.status === "done" || parsed.status === "skipped") &&
      typeof parsed.completedAt === "string" &&
      parsed.completedAt.length > 0
    ) {
      return { status: parsed.status, completedAt: parsed.completedAt };
    }
  } catch {
    // 损坏的偏好按未完成处理；后续合法写入会覆盖。
  }
  return null;
}

export function createOnboardingSettingsRoutes(
  dependencies: OnboardingSettingsDependencies = {},
): Hono {
  const routes = new Hono();
  const getSetting = dependencies.getSetting ?? getAppSetting;
  const setSetting = dependencies.setSetting ?? setAppSetting;
  const now = dependencies.now ?? (() => new Date());

  routes.get("/settings/onboarding", async (c) => {
    const rejected = requireTrustedOrigin(c);
    if (rejected) return rejected;

    const [stateRaw, ...coachValues] = await Promise.all([
      getSetting(SETTING_ONBOARDING_STATE),
      ...COACH_MARK_IDS.map((id) => getSetting(coachSettingKey(id))),
    ]);
    const response: OnboardingSettingsResponse = {
      state: parseState(stateRaw),
      coachSeen: COACH_MARK_IDS.filter((_, index) => Boolean(coachValues[index])),
    };
    return c.json(response);
  });

  routes.put("/settings/onboarding", async (c) => {
    const rejected = requireTrustedOrigin(c);
    if (rejected) return rejected;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求格式不正确，请检查后重试。" }, 400);
    }
    const parsed = updateStateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "引导状态不正确，请重试。" }, 400);
    }
    const state: OnboardingState = {
      status: parsed.data.status,
      completedAt: now().toISOString(),
    };
    await setSetting(SETTING_ONBOARDING_STATE, JSON.stringify(state));
    const response: UpdateOnboardingStateResponse = { state };
    return c.json(response);
  });

  routes.put("/settings/onboarding/coach/:id", async (c) => {
    const rejected = requireTrustedOrigin(c);
    if (rejected) return rejected;

    const id = c.req.param("id");
    if (!coachIds.has(id)) {
      return c.json({ error: "未知的引导提示。" }, 400);
    }
    const seenAt = now().toISOString();
    await setSetting(coachSettingKey(id as CoachMarkId), seenAt);
    return c.json({ ok: true, seenAt });
  });

  return routes;
}

export const onboardingSettingsRoutes = createOnboardingSettingsRoutes();

