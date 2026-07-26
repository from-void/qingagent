export interface ObservabilityDuckDbConnection {
  runAndReadAll(sql: string): Promise<{ getRowObjects(): Array<Record<string, unknown>> }>;
}

export interface ObservabilityDuckDbStore {
  db: {
    getConnection(): Promise<ObservabilityDuckDbConnection>;
    closeConnection(connection: ObservabilityDuckDbConnection): void;
  };
}

let runtimeStore: { path: string; store: ObservabilityDuckDbStore } | null = null;

export function registerObservabilityStore(
  path: string,
  store: ObservabilityDuckDbStore,
): void {
  runtimeStore = { path, store };
}

export function getObservabilityStore(path: string): ObservabilityDuckDbStore | null {
  return runtimeStore?.path === path ? runtimeStore.store : null;
}
