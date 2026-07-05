import type { SearchProvider } from "./provider.js";
import { DuckDuckGoProvider } from "./provider.js";
import { BingProvider } from "./bing.js";
import { SearxngProvider } from "./searxng.js";
import { TavilyProvider } from "./tavily.js";
import { SerperProvider } from "./serper.js";
import { BraveProvider } from "./brave.js";
import { ExaProvider } from "./exa.js";
import { JinaProvider } from "./jina.js";
import { BochaProvider } from "./bocha.js";

export const SEARCH_PROVIDER_IDS = [
  "bing",
  "ddg",
  "searxng",
  "tavily",
  "serper",
  "brave",
  "exa",
  "jina",
  "bocha",
] as const;

export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];
export type SearchProviderKind = "scrape" | "api";

export interface SearchProviderConfig {
  enabled?: boolean;
  apiKey?: string;
  url?: string;
}

export type SearchProviderConfigMap = Partial<Record<SearchProviderId, SearchProviderConfig>>;

export interface SearchProviderRegistryEntry {
  id: SearchProviderId;
  label: string;
  kind: SearchProviderKind;
  keyUrl: string | null;
  freeQuotaNote: string;
  buildProvider(config: SearchProviderConfig): SearchProvider;
}

export const SEARCH_PROVIDER_REGISTRY: SearchProviderRegistryEntry[] = [
  {
    id: "bing",
    label: "Bing 爬取",
    kind: "scrape",
    keyUrl: null,
    freeQuotaNote: "免费 SERP 爬取,可能被反爬",
    buildProvider: () => new BingProvider(),
  },
  {
    id: "ddg",
    label: "DuckDuckGo",
    kind: "scrape",
    keyUrl: null,
    freeQuotaNote: "免费 SERP 爬取,部分网络环境可能不可达",
    buildProvider: () => new DuckDuckGoProvider(),
  },
  {
    id: "searxng",
    label: "SearXNG",
    kind: "scrape",
    keyUrl: "https://docs.searxng.org/",
    freeQuotaNote: "自建实例免费,由实例容量决定",
    buildProvider: (config) => new SearxngProvider(config.url),
  },
  {
    id: "tavily",
    label: "Tavily",
    kind: "api",
    keyUrl: "https://app.tavily.com/",
    freeQuotaNote: "免费层约 1,000 credits/月,以 Tavily 控制台为准",
    buildProvider: (config) => new TavilyProvider(config.apiKey ?? ""),
  },
  {
    id: "serper",
    label: "Serper(Google)",
    kind: "api",
    keyUrl: "https://serper.dev/",
    freeQuotaNote: "注册赠送 2,500 次查询",
    buildProvider: (config) => new SerperProvider(config.apiKey ?? ""),
  },
  {
    id: "brave",
    label: "Brave Search",
    kind: "api",
    keyUrl: "https://api-dashboard.search.brave.com/app/keys",
    freeQuotaNote: "每月 $5 免费额度,约 1,000 次 Search 请求",
    buildProvider: (config) => new BraveProvider(config.apiKey ?? ""),
  },
  {
    id: "exa",
    label: "Exa",
    kind: "api",
    keyUrl: "https://dashboard.exa.ai/api-keys",
    freeQuotaNote: "免费层最高 20,000 次/月,以 Exa 价格页为准",
    buildProvider: (config) => new ExaProvider(config.apiKey ?? ""),
  },
  {
    id: "jina",
    label: "Jina Search",
    kind: "api",
    keyUrl: "https://jina.ai/reader/",
    freeQuotaNote: "API key 含免费 token 额度,搜索按 token 计费",
    buildProvider: (config) => new JinaProvider(config.apiKey ?? ""),
  },
  {
    id: "bocha",
    label: "博查",
    kind: "api",
    keyUrl: "https://open.bochaai.com/",
    freeQuotaNote: "按量人民币计费,以博查控制台为准",
    buildProvider: (config) => new BochaProvider(config.apiKey ?? ""),
  },
];

export function isSearchProviderId(value: string): value is SearchProviderId {
  return (SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}

export function getSearchProviderRegistryEntry(
  id: SearchProviderId,
): SearchProviderRegistryEntry {
  const entry = SEARCH_PROVIDER_REGISTRY.find((item) => item.id === id);
  if (!entry) throw new Error(`Unknown search provider: ${id}`);
  return entry;
}
