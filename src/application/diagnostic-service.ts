import { calibrateTelemetry } from '../domain/calibration/apply.ts';
import { advanceHealth, initialHealth } from '../domain/health/advance.ts';
import { estimateRemainingLife } from '../domain/life/estimate.ts';
import { evaluatePerformance } from '../domain/performance/evaluate.ts';
import { segmentOperatingPhases } from '../domain/phase/segment.ts';
import { inferRootCauses } from '../domain/root-cause/infer.ts';
import { replayTelemetry } from '../domain/timeline/replay.ts';
import { diagnoseVibration } from '../domain/vibration/fuse.ts';
import type { Calibration, CausalEdge, CausalObservation, LifeModelInput, PerformanceInput, TelemetryEvent, VibrationEvidence } from '../domain/types.ts';

type AnalysisInput = { events: TelemetryEvent[]; calibrations: Calibration[]; performance: PerformanceInput; vibrationEvidence?: VibrationEvidence[]; healthIntervals?: Parameters<typeof advanceHealth>[1]; rootObservations?: CausalObservation[]; rootEdges?: CausalEdge[]; life?: LifeModelInput };
type AnalysisContext = { runId: string | null; replayed: TelemetryEvent[]; calibrated: ReturnType<typeof calibrateTelemetry>; phases: ReturnType<typeof segmentOperatingPhases>; performance: ReturnType<typeof evaluatePerformance> };

function emptyContext(): AnalysisContext { return { runId: null, replayed: [], calibrated: [], phases: [], performance: {} as ReturnType<typeof evaluatePerformance> }; }

function commit(context: AnalysisContext, input: AnalysisInput, vibration: ReturnType<typeof diagnoseVibration>, health: ReturnType<typeof advanceHealth>, rootCause: ReturnType<typeof inferRootCauses>, life: ReturnType<typeof estimateRemainingLife> | null) {
  return { runId: context.runId, telemetry: { received: input.events.length, replayed: context.replayed.length, calibrated: context.calibrated.length }, phases: context.phases, performance: context.performance, vibration, health, rootCause, life };
}

export const diagnosticService = {
  replay(events: TelemetryEvent[]) { return replayTelemetry(events); },
  performance(input: PerformanceInput) { return evaluatePerformance(input); },
  vibration(evidence: VibrationEvidence[], prior?: number) { return diagnoseVibration(evidence, prior); },
  health(intervals: Parameters<typeof advanceHealth>[1], initial = initialHealth()) { return advanceHealth(initial, intervals); },
  rootCause(observations: CausalObservation[], edges: CausalEdge[]) { return inferRootCauses(observations, edges); },
  life(input: LifeModelInput) { return estimateRemainingLife(input); },
  analyze(input: AnalysisInput) {
    let context = emptyContext();
    try {
      const replayed = replayTelemetry(input.events);
      context = { ...context, runId: replayed[0]?.runId ?? null, replayed };
      context = { ...context, calibrated: calibrateTelemetry(replayed, input.calibrations) };
      context = { ...context, phases: segmentOperatingPhases(context.calibrated), performance: evaluatePerformance(input.performance) };
      const vibration = diagnoseVibration(input.vibrationEvidence ?? []);
      const health = advanceHealth(initialHealth(), input.healthIntervals ?? []);
      const rootCause = inferRootCauses(input.rootObservations ?? [], input.rootEdges ?? []);
      const life = input.life ? estimateRemainingLife(input.life) : null;
      return commit(context, input, vibration, health, rootCause, life);
    } catch (error) {
      const vibration = diagnoseVibration(input.vibrationEvidence ?? []);
      const health = advanceHealth(initialHealth(), input.healthIntervals ?? []);
      const rootCause = inferRootCauses(input.rootObservations ?? [], input.rootEdges ?? []);
      return commit(context, input, vibration, health, rootCause, null);
    }
  },
};
