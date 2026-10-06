import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisError, diagnosticService } from '../src/application/diagnostic-service.ts';

const events = [
  { runId: 'run-1', eventId: 'e1', sampleTimeMs: 0, receivedTimeMs: 1, sequence: 0, sensor: 'rpm', value: 800, unit: 'rpm' },
  { runId: 'run-1', eventId: 'e2', sampleTimeMs: 1000, receivedTimeMs: 1001, sequence: 1, sensor: 'rpm', value: 5000, unit: 'rpm' },
  { runId: 'run-1', eventId: 'e3', sampleTimeMs: 2000, receivedTimeMs: 2001, sequence: 2, sensor: 'rpm', value: 5000, unit: 'rpm' },
] as any;

const calibrations = [{ sensor: 'rpm', version: 'rpm-v1', effectiveFromMs: 0, scale: 1, offset: 0, uncertainty: 0.5 }] as any;

const performance = { rpm: 9000, fuelFlowKgPerSecond: 2, compressorOutletPressureKpa: 900, turbineInletTemperatureK: 1000, ambientPressureKpa: 101.3, ambientTemperatureK: 288, inletPressureKpa: 100, referenceRpm: 10000, referenceTemperatureK: 288, referencePressureKpa: 101.3 };

const healthIntervals = [{ durationHours: 2, temperatureK: 900, vibrationRms: 1, operatingLoad: 1 }];

function catchError(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return error; }
  assert.fail('expected the analysis to throw');
}

test('analyze commits every stage exactly once in dependency order', () => {
  const report = diagnosticService.analyze({ events, calibrations, performance, healthIntervals } as any);
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.stages.completed, ['replay', 'calibration', 'segmentation', 'performance', 'vibration', 'health', 'rootCause']);
  assert.deepEqual(report.stages.skipped, ['life']);
  assert.equal(report.runId, 'run-1');
  assert.equal(report.health.version, 1);
  assert.equal(report.health.elapsedHours, 2);
});

test('analyze runs the life stage only when life input is provided', () => {
  const life = { initialHealth: { compressorEfficiency: 0.95, turbineFlowCapacity: 0.96, bearingFriction: 0.02, hotSectionMargin: 0.9, elapsedHours: 100, version: 1 }, horizonHours: 10000, samples: 50, seed: 7, meanDegradationPerHour: 0.0002, deviation: 0.00003, temperatureStress: 0.2, vibrationStress: 0.1, failureThreshold: 0.4, correlation: [[1, 0.3], [0.3, 1]] };
  const report = diagnosticService.analyze({ events, calibrations, performance, life } as any);
  assert.deepEqual(report.stages.completed, ['replay', 'calibration', 'segmentation', 'performance', 'vibration', 'health', 'rootCause', 'life']);
  assert.deepEqual(report.stages.skipped, []);
  assert.ok(report.life);
});

test('failure preserves the original error and the completed-stage context', () => {
  const error = catchError(() => diagnosticService.analyze({ events, calibrations: [], performance, healthIntervals } as any));
  assert.ok(error instanceof AnalysisError);
  assert.equal(error.code, 'ANALYSIS_STAGE_FAILED');
  assert.equal(error.stage, 'calibration');
  assert.deepEqual(error.completedStages, ['replay']);
  const details = error.details as any;
  assert.equal(details.cause.code, 'CALIBRATION_MISSING');
  assert.equal(details.completedContext.runId, 'run-1');
  assert.equal(details.completedContext.telemetry.replayed, 3);
  assert.equal(details.completedContext.vibration, null);
  assert.equal(details.completedContext.health, null);
  assert.equal(details.completedContext.rootCause, null);
});

test('failure at a later stage reports all previously committed stages', () => {
  const badPerformance = { ...performance, ambientTemperatureK: 0 };
  const error = catchError(() => diagnosticService.analyze({ events, calibrations, performance: badPerformance } as any));
  assert.ok(error instanceof AnalysisError);
  assert.equal(error.stage, 'performance');
  assert.deepEqual(error.completedStages, ['replay', 'calibration', 'segmentation']);
  const details = error.details as any;
  assert.equal(details.cause.code, 'INVALID_TEMPERATURE');
  assert.ok(Array.isArray(details.completedContext.phases));
  assert.equal(details.completedContext.performance, null);
});

test('a failed run does not advance health or consume telemetry, so a retry starts clean', () => {
  const failing = { events, calibrations: [], performance, healthIntervals } as any;
  assert.throws(() => diagnosticService.analyze(failing));
  assert.throws(() => diagnosticService.analyze(failing));
  const report = diagnosticService.analyze({ ...failing, calibrations });
  assert.equal(report.status, 'completed');
  assert.equal(report.health.version, 1);
  assert.equal(report.health.elapsedHours, 2);
  assert.equal(report.telemetry.replayed, 3);
});

test('domain error status is preserved on analysis failure', () => {
  const conflicting = [events[0], { ...events[0], value: 900 }];
  const error = catchError(() => diagnosticService.analyze({ events: conflicting, calibrations, performance } as any));
  assert.ok(error instanceof AnalysisError);
  assert.equal(error.status, 409);
  assert.equal((error.details as any).cause.code, 'EVENT_CONFLICT');
});
