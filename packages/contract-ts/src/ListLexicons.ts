export interface ListLexicons {
  sessionId: string;
}

export interface LexiconResourceSummary {
  id: string;
  name: string;
  entryCount: number;
  description: string;
  enabled: boolean;
}

export interface SetEnabledLexicons {
  sessionId: string;
  requestId: string;
  enabledLexiconIds: string[];
}

export interface ListLexiconEntries {
  sessionId: string;
  resourceId: string;
}

export interface LexiconEntrySummary {
  word: string;
  replacement: string | null;
  note: string | null;
}
