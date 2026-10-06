import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnalysisOrchestrator, type AnalysisInput, type AnalysisOperations } from '../src/application/analysis-orchestrator.ts';
import { DomainError } from '../src/domain/errors.ts';
import * as calibration from '../src/domain/calibration/apply.ts';
import * as health from '../src/domain/health/advance.ts';
import * as life from '../src/domain/life/estimate.ts';
import * as performance from '../src/domain/performance/evaluate.ts';
import * as phase from '../src/domain/phase/segment.ts';
import * as replay from '../src/domain/timeline/replay.ts';
import * as rootCause from '../src/domain/root-cause/infer.ts';
import * as vibration from '../src/domain/vibration/fuse.ts';

const events = [
  { runId: 'run-1', eventId: 'rpm-1', sampleTimeMs: 0, receivedTimeMs: 0, sequence: 1, sensor: 'rpm', value: 800, unit: 'rpm' },
  { runId: 'run-1', eventId: 'rpm-2', sampleTimeMs: 600, receivedTimeMs: 600, sequence: 2, sensor: 'rpm', value: 900, unit: 'rpm' },
  { runId: 'run-1', eventId: 'fuel-1', sampleTimeMs: 0, receivedTimeMs: 0, sequence: 1, sensor: 'fuel-flow', value: 0.08, unit: 'kg/s' },
] as const;

const calibrations = [
  { sensor: 'rpm', version: 'rpm-v1', effectiveFromMs: 0, scale: 1, offset: 0, uncertainty: 1 },
  { sensor: 'fuel-flow', version: 'fuel-v1', effectiveFromMs: 0, scale: 1, offset: 0, uncertainty: 0.001 },
] as const;

const performanceInput = {
  rpm: 9_000,
  fuelFlowKgPerSecond: 2,
  compressorOutletPressureKpa: 900,
  turbineInletTemperatureK: 1_000,
  ambientPressureKpa: 101.3,
  ambientTemperatureK: 288,
  inletPressureKpa: 100,
  referenceRpm: 10_000,
  referenceTemperatureK: 288,
  referencePressureKpa: 101.3,
};

function input(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    events: [...events] as never,
    calibrations: [...calibrations] as never,
    performance: { ...performanceInput },
    healthIntervals: [{ durationHours: 1, temperatureK: 900, vibrationRms: 2, operatingLoad: 1 }],
    life: {
      initialHealth: health.initialHealth(),
      horizonHours: 10_000,
      samples: 10,
      seed: 42,
      meanDegradationPerHour: 0.0002,
      deviation: 0.00003,
      temperatureStress: 0.2,
      vibrationStress: 0.1,
      failureThreshold: 0.4,
      correlation: [[1, 0.3], [0.3, 1]],
    },
    ...overrides,
  };
}

function trackedOperations(overrides: Partial<AnalysisOperations> = {}) {
  const calls = {
    replay: 0,
    calibrate: 0,
    segment: 0,
    performance: 0,
    vibration: 0,
    health: 0,
    rootCause: 0,
    life: 0,
  };
  const operations: AnalysisOperations = {
    replay: (value) => { calls.replay += 1; return replay.replayTelemetry(value); },
    calibrate: (value, items) => { calls.calibrate += 1; return calibration.calibrateTelemetry(value, items); },
    segment: (value) => { calls.segment += 1; return phase.segmentOperatingPhases(value); },
    evaluatePerformance: (value) => { calls.performance += 1; return performance.evaluatePerformance(value); },
    diagnoseVibration: (value, prior) => { calls.vibration += 1; return vibration.diagnoseVibration(value, prior); },
    advanceHealth: (state, intervals) => { calls.health += 1; return health.advanceHealth(state, intervals); },
    inferRootCauses: (observations, edges) => { calls.rootCause += 1; return rootCause.inferRootCauses(observations, edges); },
    estimateRemainingLife: (value) => { calls.life += 1; return life.estimateRemainingLife(value); },
    ...overrides,
  };
  return { calls, operations };
}

test('analysis preserves the original failure and completed stage context', () => {
  const { operations } = trackedOperations({
    calibrate: () => { throw new DomainError('CALIBRATION_MISSING', 'No calibration covers telemetry sample', 422, { eventId: 'rpm-1' }); },
  });
  const orchestrator = createAnalysisOrchestrator(operations);

  assert.throws(
    () => orchestrator.analyze(input()),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, 'ANALYSIS_STAGE_FAILED');
      assert.equal(error.status, 422);
      assert.equal(error.details.failedStage, 'calibration');
      assert.deepEqual(error.details.completedStages, ['replay']);
      assert.deepEqual(error.details.originalError, {
        name: 'DomainError',
        code: 'CALIBRATION_MISSING',
        message: 'No calibration covers telemetry sample',
        status: 422,
        details: { eventId: 'rpm-1' },
      });
      const details = error.details as { partialReport: { telemetry: unknown } };
      assert.deepEqual(details.partialReport.telemetry, { received: 3, replayed: 3, calibrated: 0 });
      return true;
    },
  );
});

test('retrying a failed analysis resumes once from the failed dependency stage', () => {
  let calibrationCalls = 0;
  let healthResult: ReturnType<typeof health.advanceHealth> | undefined;
  const { calls, operations } = trackedOperations({
    calibrate: (items, itemsCalibration) => {
      calls.calibrate += 1;
      calibrationCalls += 1;
      if (calibrationCalls === 1) throw new DomainError('CALIBRATION_MISSING', 'No calibration covers telemetry sample');
      return calibration.calibrateTelemetry(items, itemsCalibration);
    },
    advanceHealth: (state, intervals) => {
      healthResult = health.advanceHealth(state, intervals);
      calls.health += 1;
      return healthResult;
    },
  });
  const orchestrator = createAnalysisOrchestrator(operations);

  assert.throws(() => orchestrator.analyze(input()), (error: unknown) => error instanceof DomainError && error.details.failedStage === 'calibration');
  const report = orchestrator.analyze(input());

  assert.equal(report.status, 'succeeded');
  assert.equal(calls.replay, 1);
  assert.equal(calls.calibrate, 2);
  assert.equal(calls.segment, 1);
  assert.equal(calls.performance, 1);
  assert.equal(calls.vibration, 1);
  assert.equal(calls.health, 1);
  assert.equal(calls.rootCause, 1);
  assert.equal(calls.life, 1);
  assert.deepEqual(report.stages.map((stage) => stage.stage), ['replay', 'calibration', 'segmentation', 'performance', 'vibration', 'health', 'root-cause', 'life']);
  assert.equal(report.life?.validSamples, 10);
  assert.ok(healthResult);
});

test('retrying after a late failure does not advance health or consume telemetry twice', () => {
  let rootCauseCalls = 0;
  const { calls, operations } = trackedOperations({
    inferRootCauses: (observations, edges) => {
      calls.rootCause += 1;
      rootCauseCalls += 1;
      if (rootCauseCalls === 1) throw new DomainError('INVALID_OBSERVATION_SCORE', 'Observation score must be in [0, 1]', 422, { id: 'obs-1' });
      return rootCause.inferRootCauses(observations, edges);
    },
  });
  const orchestrator = createAnalysisOrchestrator(operations);

  assert.throws(() => orchestrator.analyze(input()), (error: unknown) => error instanceof DomainError && error.details.failedStage === 'root-cause');
  const report = orchestrator.analyze(input());

  assert.equal(report.status, 'succeeded');
  assert.equal(calls.replay, 1);
  assert.equal(calls.vibration, 1);
  assert.equal(calls.health, 1);
  assert.equal(calls.rootCause, 2);
  assert.equal(calls.life, 1);
});

test('a successful retry returns the committed report without advancing health again', () => {
  const { calls, operations } = trackedOperations();
  const orchestrator = createAnalysisOrchestrator(operations);

  const first = orchestrator.analyze(input(), { idempotencyKey: 'analysis-1' });
  const second = orchestrator.analyze(input(), { idempotencyKey: 'analysis-1' });

  assert.deepEqual(second, first);
  assert.equal(calls.replay, 1);
  assert.equal(calls.calibrate, 1);
  assert.equal(calls.health, 1);
  assert.equal(calls.life, 1);
});

test('a different payload cannot reuse an idempotency key', () => {
  const { operations } = trackedOperations();
  const orchestrator = createAnalysisOrchestrator(operations);
  orchestrator.analyze(input(), { idempotencyKey: 'analysis-2' });

  assert.throws(
    () => orchestrator.analyze(input({ calibrations: [] as never }), { idempotencyKey: 'analysis-2' }),
    (error: unknown) => error instanceof DomainError && error.code === 'IDEMPOTENCY_KEY_REUSE' && error.status === 409,
  );
});

test('the same telemetry run cannot be consumed by a second analysis', () => {
  const { operations } = trackedOperations();
  const orchestrator = createAnalysisOrchestrator(operations);
  orchestrator.analyze(input(), { idempotencyKey: 'analysis-3' });

  assert.throws(
    () => orchestrator.analyze(input(), { idempotencyKey: 'analysis-4' }),
    (error: unknown) => error instanceof DomainError && error.code === 'TELEMETRY_RUN_ALREADY_CONSUMED' && error.status === 409,
  );
});
