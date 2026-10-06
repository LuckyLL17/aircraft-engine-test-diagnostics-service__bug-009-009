import { createAnalysisOrchestrator, type AnalyzeOptions, type AnalysisInput } from './analysis-orchestrator.ts';
import { advanceHealth, initialHealth } from '../domain/health/advance.ts';
import { estimateRemainingLife } from '../domain/life/estimate.ts';
import { evaluatePerformance } from '../domain/performance/evaluate.ts';
import { inferRootCauses } from '../domain/root-cause/infer.ts';
import { replayTelemetry } from '../domain/timeline/replay.ts';
import { diagnoseVibration } from '../domain/vibration/fuse.ts';
import type { CausalEdge, CausalObservation, LifeModelInput, PerformanceInput, TelemetryEvent, VibrationEvidence } from '../domain/types.ts';

const orchestrator = createAnalysisOrchestrator();

export const diagnosticService = {
  replay(events: TelemetryEvent[]) { return replayTelemetry(events); },
  performance(input: PerformanceInput) { return evaluatePerformance(input); },
  vibration(evidence: VibrationEvidence[], prior?: number) { return diagnoseVibration(evidence, prior); },
  health(intervals: Parameters<typeof advanceHealth>[1], initial = initialHealth()) { return advanceHealth(initial, intervals); },
  rootCause(observations: CausalObservation[], edges: CausalEdge[]) { return inferRootCauses(observations, edges); },
  life(input: LifeModelInput) { return estimateRemainingLife(input); },
  analyze(input: AnalysisInput, options?: AnalyzeOptions) { return orchestrator.analyze(input, options); },
};
