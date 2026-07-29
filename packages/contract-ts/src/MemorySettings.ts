export interface MemorySettingsResponse {
  content: string;
  exists: boolean;
  maxChars: number;
}

export interface UpdateMemorySettingsRequest {
  content: string;
  baseContent: string;
}
