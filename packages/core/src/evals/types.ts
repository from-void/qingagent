import type { MastraScorer } from "@mastra/core/evals";

export interface OfflineScorerFixture<TInput = unknown, TOutput = unknown, TGroundTruth = unknown> {
  id: string;
  source: string;
  input?: TInput;
  output: TOutput;
  groundTruth?: TGroundTruth;
}

export interface OfflineScorerSuite<TInput = unknown, TOutput = unknown, TGroundTruth = unknown> {
  id: string;
  description: string;
  scorer: MastraScorer<any, any, any, any>;
  fixtures: OfflineScorerFixture<TInput, TOutput, TGroundTruth>[];
  threshold: number;
}

export interface ScorerCheck {
  ok: boolean;
  note: string;
}
