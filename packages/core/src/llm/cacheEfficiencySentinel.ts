export const CACHE_SENTINEL_WINDOW_SIZE = 3;
export const CACHE_SENTINEL_MAX_KEYS = 500;
export const CACHE_SENTINEL_DEFAULT_MIN_HIT_RATE = 0.7;
export const CACHE_SENTINEL_DEFAULT_MIN_MISS = 10_000;
export const CACHE_SENTINEL_MIN_SAMPLE_TOKENS = 4_096;

interface CacheSample {
  hitTokens: number;
  missTokens: number;
}

interface CacheWindowState {
  samples: CacheSample[];
  validSamplesSinceWarning: number;
  hasWarned: boolean;
}

export interface CacheOutcome {
  sessionId: string;
  callSite: string;
  hitTokens: number;
  missTokens: number;
}

const cacheWindows = new Map<string, CacheWindowState>();

function readMinHitRate(): number {
  const raw = process.env.QINGAGENT_CACHE_SENTINEL_MIN_HIT_RATE?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : CACHE_SENTINEL_DEFAULT_MIN_HIT_RATE;
}

function readMinMiss(): number {
  const raw = process.env.QINGAGENT_CACHE_SENTINEL_MIN_MISS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : CACHE_SENTINEL_DEFAULT_MIN_MISS;
}

function isEnabled(): boolean {
  return process.env.QINGAGENT_CACHE_SENTINEL?.trim() !== "0";
}

function promote(key: string, state: CacheWindowState): void {
  cacheWindows.delete(key);
  cacheWindows.set(key, state);
  while (cacheWindows.size > CACHE_SENTINEL_MAX_KEYS) {
    const oldest = cacheWindows.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cacheWindows.delete(oldest);
  }
}

/**
 * 观察一次已知缓存 usage。哨兵必须完全旁路：任何异常都只丢失告警，不能影响入账或模型主链。
 */
export function observeCacheOutcome(input: CacheOutcome): void {
  try {
    if (!isEnabled()) return;
    const { hitTokens, missTokens } = input;
    if (
      !Number.isFinite(hitTokens) ||
      !Number.isFinite(missTokens) ||
      hitTokens < 0 ||
      missTokens < 0 ||
      hitTokens + missTokens < CACHE_SENTINEL_MIN_SAMPLE_TOKENS
    ) {
      return;
    }

    const key = `${input.sessionId}:${input.callSite}`;
    const state = cacheWindows.get(key) ?? {
      samples: [],
      validSamplesSinceWarning: 0,
      hasWarned: false,
    };
    state.samples.push({ hitTokens, missTokens });
    if (state.samples.length > CACHE_SENTINEL_WINDOW_SIZE) state.samples.shift();
    if (state.hasWarned) state.validSamplesSinceWarning += 1;
    promote(key, state);

    if (state.samples.length < CACHE_SENTINEL_WINDOW_SIZE) return;
    if (state.hasWarned && state.validSamplesSinceWarning < CACHE_SENTINEL_WINDOW_SIZE) return;

    const minHitRate = readMinHitRate();
    const minMiss = readMinMiss();
    const allDegraded = state.samples.every((sample) =>
      sample.hitTokens / (sample.hitTokens + sample.missTokens) < minHitRate &&
      sample.missTokens >= minMiss
    );
    if (!allDegraded) return;

    const hitMissSequence = state.samples.map((sample) =>
      `${sample.hitTokens}/${sample.missTokens}`
    );
    console.warn(
      `[cacheSentinel] site=${input.callSite} session=${input.sessionId} ` +
        `连续低命中+大 miss(疑似前缀分叉/积压) samples=${hitMissSequence.join(",")}`,
      {
        site: input.callSite,
        session: input.sessionId,
        minHitRate,
        minMiss,
        hitMissSequence,
      },
    );
    state.hasWarned = true;
    state.validSamplesSinceWarning = 0;
  } catch {
    // 告警链路永远不能反向影响 usage 入账或模型请求。
  }
}

export function resetCacheEfficiencySentinelForTests(): void {
  cacheWindows.clear();
}
