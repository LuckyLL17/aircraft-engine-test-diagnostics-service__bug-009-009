import { calibrateTelemetry } from '../domain/calibration/apply.ts';
import { DomainError } from '../domain/errors.ts';
import { advanceHealth, initialHealth } from '../domain/health/advance.ts';
import { estimateRemainingLife } from '../domain/life/estimate.ts';
import { evaluatePerformance } from '../domain/performance/evaluate.ts';
import { segmentOperatingPhases } from '../domain/phase/segment.ts';
import { inferRootCauses } from '../domain/root-cause/infer.ts';
import { replayTelemetry } from '../domain/timeline/replay.ts';
import { diagnoseVibration } from '../domain/vibration/fuse.ts';
import type { Calibration, CalibratedSample, CausalEdge, CausalObservation, ComponentHealth, FaultCandidate, HealthInterval, LifeEstimate, LifeModelInput, PerformanceInput, PerformanceSnapshot, PhaseSegment, RootCauseResult, TelemetryEvent, VibrationEvidence } from '../domain/types.ts';

export type AnalysisInput = { events: TelemetryEvent[]; calibrations: Calibration[]; performance: PerformanceInput; vibrationEvidence?: VibrationEvidence[]; healthIntervals?: HealthInterval[]; rootObservations?: CausalObservation[]; rootEdges?: CausalEdge[]; life?: LifeModelInput };

// 阶段按依赖顺序排列：回放 → 校准 → 分段 → 性能 → 振动 → 健康 → 根因 → 寿命。
export const ANALYSIS_STAGES = ['replay', 'calibration', 'segmentation', 'performance', 'vibration', 'health', 'rootCause', 'life'] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

type AnalysisContext = {
  runId: string | null;
  replayed: TelemetryEvent[];
  calibrated: CalibratedSample[];
  phases: PhaseSegment[] | null;
  performance: PerformanceSnapshot | null;
  vibration: FaultCandidate[] | null;
  health: ComponentHealth | null;
  rootCause: RootCauseResult | null;
  life: LifeEstimate | null;
};

function emptyContext(): AnalysisContext {
  return { runId: null, replayed: [], calibrated: [], phases: null, performance: null, vibration: null, health: null, rootCause: null, life: null };
}

// 失败时随错误一起返回的已完成阶段上下文：未提交的阶段保持 null，绝不回填伪造结果。
function contextSnapshot(context: AnalysisContext) {
  return {
    runId: context.runId,
    telemetry: { replayed: context.replayed.length, calibrated: context.calibrated.length },
    phases: context.phases,
    performance: context.performance,
    vibration: context.vibration,
    health: context.health,
    rootCause: context.rootCause,
  };
}

export class AnalysisError extends DomainError {
  readonly stage: AnalysisStage;
  readonly completedStages: AnalysisStage[];

  constructor(stage: AnalysisStage, completedStages: readonly AnalysisStage[], context: AnalysisContext, cause: unknown) {
    const original = cause instanceof Error ? cause : new Error(String(cause));
    const domain = cause instanceof DomainError ? cause : null;
    super('ANALYSIS_STAGE_FAILED', `Analysis stage '${stage}' failed: ${original.message}`, domain?.status ?? 500, {
      stage,
      completedStages: [...completedStages],
      cause: { code: domain?.code ?? 'INTERNAL_ERROR', message: original.message, ...(domain ? { details: domain.details } : {}) },
      completedContext: contextSnapshot(context),
    });
    this.name = 'AnalysisError';
    this.stage = stage;
    this.completedStages = [...completedStages];
    this.cause = original;
  }
}

// 单次分析运行的编排器。每个阶段先执行、后提交，提交恰好一次：
// 执行失败时上下文保持未提交状态并包装为 AnalysisError 抛出；
// 不做任何内部重试，因此健康状态不会被重复推进、遥测输入不会被重复消费。
function createPipeline() {
  const context = emptyContext();
  const committed = new Set<AnalysisStage>();
  const completedStages: AnalysisStage[] = [];

  function runStage<T>(stage: AnalysisStage, execute: () => T, commit: (value: T) => void): T {
    if (committed.has(stage)) throw new DomainError('STAGE_ALREADY_COMMITTED', `Analysis stage '${stage}' cannot be committed twice in one run`, 500, { stage });
    let value: T;
    try {
      value = execute();
    } catch (error) {
      if (error instanceof AnalysisError) throw error;
      throw new AnalysisError(stage, completedStages, context, error);
    }
    commit(value);
    committed.add(stage);
    completedStages.push(stage);
    return value;
  }

  return { context, completedStages, runStage };
}

export const diagnosticService = {
  replay(events: TelemetryEvent[]) { return replayTelemetry(events); },
  performance(input: PerformanceInput) { return evaluatePerformance(input); },
  vibration(evidence: VibrationEvidence[], prior?: number) { return diagnoseVibration(evidence, prior); },
  health(intervals: HealthInterval[], initial = initialHealth()) { return advanceHealth(initial, intervals); },
  rootCause(observations: CausalObservation[], edges: CausalEdge[]) { return inferRootCauses(observations, edges); },
  life(input: LifeModelInput) { return estimateRemainingLife(input); },
  analyze(input: AnalysisInput) {
    // 每次调用创建全新的流水线：跨调用不保留任何可变状态，
    // 调用方重试会从 initialHealth() 和原始遥测重新完整推进，不会叠加上一轮的结果。
    const pipeline = createPipeline();
    const { context } = pipeline;

    pipeline.runStage('replay', () => replayTelemetry(input.events), (replayed) => {
      context.runId = replayed[0]?.runId ?? null;
      context.replayed = replayed;
    });
    pipeline.runStage('calibration', () => calibrateTelemetry(context.replayed, input.calibrations), (calibrated) => { context.calibrated = calibrated; });
    pipeline.runStage('segmentation', () => segmentOperatingPhases(context.calibrated), (phases) => { context.phases = phases; });
    pipeline.runStage('performance', () => evaluatePerformance(input.performance), (performance) => { context.performance = performance; });
    pipeline.runStage('vibration', () => diagnoseVibration(input.vibrationEvidence ?? []), (vibration) => { context.vibration = vibration; });
    pipeline.runStage('health', () => advanceHealth(initialHealth(), input.healthIntervals ?? []), (health) => { context.health = health; });
    pipeline.runStage('rootCause', () => inferRootCauses(input.rootObservations ?? [], input.rootEdges ?? []), (rootCause) => { context.rootCause = rootCause; });
    if (input.life) pipeline.runStage('life', () => estimateRemainingLife(input.life!), (life) => { context.life = life; });

    return {
      status: 'completed' as const,
      runId: context.runId,
      stages: { completed: [...pipeline.completedStages], skipped: (input.life ? [] : ['life']) as AnalysisStage[] },
      telemetry: { received: input.events.length, replayed: context.replayed.length, calibrated: context.calibrated.length },
      phases: context.phases!,
      performance: context.performance!,
      vibration: context.vibration!,
      health: context.health!,
      rootCause: context.rootCause!,
      life: context.life,
    };
  },
};
