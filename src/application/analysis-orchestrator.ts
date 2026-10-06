import { createHash } from 'node:crypto';
import { calibrateTelemetry } from '../domain/calibration/apply.ts';
import { DomainError } from '../domain/errors.ts';
import { advanceHealth, initialHealth } from '../domain/health/advance.ts';
import { estimateRemainingLife } from '../domain/life/estimate.ts';
import { evaluatePerformance } from '../domain/performance/evaluate.ts';
import { segmentOperatingPhases } from '../domain/phase/segment.ts';
import { inferRootCauses } from '../domain/root-cause/infer.ts';
import { replayTelemetry } from '../domain/timeline/replay.ts';
import { diagnoseVibration } from '../domain/vibration/fuse.ts';
import type { CalibratedSample, Calibration, CausalEdge, CausalObservation, ComponentHealth, FaultCandidate, LifeEstimate, LifeModelInput, PerformanceInput, PerformanceSnapshot, PhaseSegment, RootCauseResult, TelemetryEvent, VibrationEvidence } from '../domain/types.ts';

export const analysisStages = ['replay', 'calibration', 'segmentation', 'performance', 'vibration', 'health', 'root-cause', 'life'] as const;
export type AnalysisStage = typeof analysisStages[number];

export type AnalysisInput = {
  idempotencyKey?: string;
  events: TelemetryEvent[];
  calibrations: Calibration[];
  performance: PerformanceInput;
  vibrationEvidence?: VibrationEvidence[];
  healthIntervals?: Parameters<typeof advanceHealth>[1];
  rootObservations?: CausalObservation[];
  rootEdges?: CausalEdge[];
  life?: LifeModelInput;
};

export type StageReceipt = {
  stage: AnalysisStage;
  status: 'succeeded' | 'skipped';
};

export type AnalysisReport = {
  runId: string | null;
  status: 'succeeded';
  telemetry: { received: number; replayed: number; calibrated: number };
  phases: PhaseSegment[];
  performance: PerformanceSnapshot;
  vibration: FaultCandidate[];
  health: ComponentHealth;
  rootCause: RootCauseResult;
  life: LifeEstimate | null;
  stages: StageReceipt[];
};

export type PartialAnalysisReport = {
  runId: string | null;
  telemetry?: { received: number; replayed: number; calibrated: number };
  phases?: PhaseSegment[];
  performance?: PerformanceSnapshot;
  vibration?: FaultCandidate[];
  health?: ComponentHealth;
  rootCause?: RootCauseResult;
};

type StageResults = Partial<{
  replay: TelemetryEvent[];
  calibration: CalibratedSample[];
  segmentation: PhaseSegment[];
  performance: PerformanceSnapshot;
  vibration: FaultCandidate[];
  health: ComponentHealth;
  'root-cause': RootCauseResult;
  life: LifeEstimate | null;
}>;

type AnalysisState = {
  key: string;
  fingerprint: string;
  runId: string | null;
  receivedCount: number;
  results: StageResults;
  completedStages: AnalysisStage[];
};

type AnalysisJob = {
  state: AnalysisState;
  response: AnalysisReport | null;
};

export type AnalysisOperations = {
  replay: typeof replayTelemetry;
  calibrate: typeof calibrateTelemetry;
  segment: typeof segmentOperatingPhases;
  evaluatePerformance: typeof evaluatePerformance;
  diagnoseVibration: typeof diagnoseVibration;
  advanceHealth: typeof advanceHealth;
  inferRootCauses: typeof inferRootCauses;
  estimateRemainingLife: typeof estimateRemainingLife;
};

export type AnalyzeOptions = { idempotencyKey?: string };

const defaultOperations: AnalysisOperations = {
  replay: replayTelemetry,
  calibrate: calibrateTelemetry,
  segment: segmentOperatingPhases,
  evaluatePerformance,
  diagnoseVibration,
  advanceHealth,
  inferRootCauses,
  estimateRemainingLife,
};

function describeOriginalError(error: unknown): Record<string, unknown> {
  if (error instanceof DomainError) {
    return { name: error.name, code: error.code, message: error.message, status: error.status, details: structuredClone(error.details) };
  }
  if (error instanceof Error) return { name: error.name, code: 'OPERATION_FAILED', message: error.message };
  return { name: 'UnknownError', code: 'OPERATION_FAILED', message: String(error) };
}

export class AnalysisStageError extends DomainError {
  readonly failedStage: AnalysisStage;
  readonly completedStages: AnalysisStage[];
  readonly completedContext: StageResults;
  readonly partialReport: PartialAnalysisReport;

  constructor(stage: AnalysisStage, cause: unknown, state: AnalysisState, receivedCount: number) {
    const completedContext = structuredClone(state.results);
    const partialReport = toPartialReport(state, receivedCount);
    super('ANALYSIS_STAGE_FAILED', `Analysis failed at stage "${stage}"`, cause instanceof DomainError ? cause.status : 500, {
      failedStage: stage,
      completedStages: [...state.completedStages],
      originalError: describeOriginalError(cause),
      completedContext,
      partialReport: structuredClone(partialReport),
    });
    this.name = 'AnalysisStageError';
    this.failedStage = stage;
    this.completedStages = [...state.completedStages];
    this.completedContext = completedContext;
    this.partialReport = partialReport;
    if (cause instanceof Error) this.cause = cause;
  }
}

function toPartialReport(state: AnalysisState, receivedCount: number): PartialAnalysisReport {
  const report: PartialAnalysisReport = { runId: state.runId };
  if (state.results.replay) {
    report.telemetry = {
      received: receivedCount,
      replayed: state.results.replay.length,
      calibrated: state.results.calibration?.length ?? 0,
    };
  }
  if (state.results.segmentation) report.phases = state.results.segmentation;
  if (state.results.performance) report.performance = state.results.performance;
  if (state.results.vibration) report.vibration = state.results.vibration;
  if (state.results.health) report.health = state.results.health;
  if (state.results['root-cause']) report.rootCause = state.results['root-cause'];
  return structuredClone(report);
}

function canonicalFingerprint(value: unknown): string {
  if (value === null) return 'null:';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalFingerprint(item)).join(',')}]`;
  const type = typeof value;
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalFingerprint(record[key])}`).join(',')}}`;
  }
  return `${type}:${String(value)}`;
}

function fingerprintInput(input: Omit<AnalysisInput, 'idempotencyKey'>): string {
  return createHash('sha256').update(canonicalFingerprint(input)).digest('hex');
}

function firstRunId(events: unknown): string | null {
  if (!Array.isArray(events)) return null;
  for (const event of events) {
    if (event && typeof event === 'object' && typeof (event as { runId?: unknown }).runId === 'string' && (event as { runId: string }).runId.length > 0) {
      return (event as { runId: string }).runId;
    }
  }
  return null;
}

export function createAnalysisOrchestrator(operations: AnalysisOperations = defaultOperations) {
  const jobs = new Map<string, AnalysisJob>();
  const consumedRuns = new Map<string, string>();

  function runStage<T>(state: AnalysisState, stage: AnalysisStage, run: () => T): T | undefined {
    if (state.completedStages.includes(stage)) return state.results[stage] as T;
    try {
      const result = run();
      state.results[stage] = result as never;
      state.completedStages.push(stage);
      return result;
    } catch (error) {
      throw new AnalysisStageError(stage, error, state, state.receivedCount);
    }
  }

  function execute(state: AnalysisState, input: Omit<AnalysisInput, 'idempotencyKey'>): AnalysisReport {
    runStage(state, 'replay', () => {
      const replayed = operations.replay(input.events);
      state.runId = replayed[0]?.runId ?? null;
      if (state.runId) {
        const owner = consumedRuns.get(state.runId);
        if (owner && owner !== state.key) {
          throw new DomainError('TELEMETRY_RUN_ALREADY_CONSUMED', 'This test run has already been consumed by another analysis', 409, { runId: state.runId, ownerKey: owner });
        }
        consumedRuns.set(state.runId, state.key);
      }
      return replayed;
    });

    const replayed = state.results.replay ?? [];
    const calibrated = runStage(state, 'calibration', () => operations.calibrate(replayed, input.calibrations))!;
    const phases = runStage(state, 'segmentation', () => operations.segment(calibrated))!;
    const performanceSnapshot = runStage(state, 'performance', () => operations.evaluatePerformance(input.performance))!;
    const vibrationCandidates = runStage(state, 'vibration', () => operations.diagnoseVibration(input.vibrationEvidence ?? []))!;
    const healthState = runStage(state, 'health', () => operations.advanceHealth(initialHealth(), input.healthIntervals ?? []))!;
    const rootCauseResult = runStage(state, 'root-cause', () => operations.inferRootCauses(input.rootObservations ?? [], input.rootEdges ?? []))!;
    const lifeModel = input.life ? { ...input.life, initialHealth: healthState } : null;
    const lifeEstimate: LifeEstimate | null = lifeModel
      ? runStage(state, 'life', () => operations.estimateRemainingLife(lifeModel))!
      : null;

    return {
      runId: state.runId,
      status: 'succeeded',
      telemetry: { received: input.events.length, replayed: replayed.length, calibrated: calibrated.length },
      phases,
      performance: performanceSnapshot,
      vibration: vibrationCandidates,
      health: healthState,
      rootCause: rootCauseResult,
      life: lifeEstimate,
      stages: analysisStages.map((stage) => ({ stage, status: stage === 'life' && !input.life ? 'skipped' : 'succeeded' })),
    };
  }

  return {
    analyze(rawInput: AnalysisInput, options: AnalyzeOptions = {}): AnalysisReport {
      const { idempotencyKey: bodyKey, ...payload } = rawInput;
      const requestedKey = options.idempotencyKey ?? bodyKey;
      if (requestedKey !== undefined && (typeof requestedKey !== 'string' || requestedKey.trim().length === 0)) {
        throw new DomainError('INVALID_IDEMPOTENCY_KEY', 'Idempotency key must be a non-empty string', 400);
      }

      const fingerprint = fingerprintInput(payload as Omit<AnalysisInput, 'idempotencyKey'>);
      const runId = firstRunId((payload as AnalysisInput).events);
      const key = requestedKey ? `key:${requestedKey}` : runId ? `run:${runId}` : `anonymous:${fingerprint}`;
      const existing = jobs.get(key);
      if (existing && existing.state.fingerprint !== fingerprint) {
        throw new DomainError('IDEMPOTENCY_KEY_REUSE', 'The same idempotency key cannot be reused with a different payload', 409, { key });
      }
      const runOwner = runId ? consumedRuns.get(runId) : undefined;
      if (runId && runOwner && runOwner !== key) {
        throw new DomainError('TELEMETRY_RUN_ALREADY_CONSUMED', 'This test run has already been consumed by another analysis', 409, { runId, ownerKey: runOwner });
      }
      if (existing?.response) return structuredClone(existing.response);

      const receivedCount = Array.isArray((payload as AnalysisInput).events) ? (payload as AnalysisInput).events.length : 0;
      const state = existing?.state ?? { key, fingerprint, runId: null, receivedCount, results: {}, completedStages: [] };
      if (!existing) jobs.set(key, { state, response: null });

      try {
        const report = execute(state, payload as Omit<AnalysisInput, 'idempotencyKey'>);
        const job = jobs.get(key)!;
        job.response = report;
        return structuredClone(report);
      } catch (error) {
        if (error instanceof AnalysisStageError) throw error;
        throw new AnalysisStageError('replay', error, state, Array.isArray((payload as AnalysisInput).events) ? (payload as AnalysisInput).events.length : 0);
      }
    },
  };
}
