export const COACH_MARK_IDS = [
  "home-settings",
  "home-new",
  "home-fab",
  "editor-input",
] as const;

export type CoachMarkId = (typeof COACH_MARK_IDS)[number];
export type OnboardingStatus = "done" | "skipped";

export interface OnboardingState {
  status: OnboardingStatus;
  completedAt: string;
}

export interface OnboardingSettingsResponse {
  state: OnboardingState | null;
  coachSeen: CoachMarkId[];
}

export interface UpdateOnboardingStateRequest {
  status: OnboardingStatus;
}

export interface UpdateOnboardingStateResponse {
  state: OnboardingState;
}

