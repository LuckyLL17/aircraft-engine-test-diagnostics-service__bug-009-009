import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { createServer } from '../src/http/server.ts';

function postJson(port: number, path: string, body: unknown, idempotencyKey?: string): Promise<{ status: number; payload: any }> {
  return new Promise((resolve, reject) => {
    const serialized = JSON.stringify(body);
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(serialized),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(serialized);
  });
}

test('analyze returns an explicit HTTP failure with completed context', async (t) => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await postJson(address.port, '/v1/test-runs/analyze', {
    events: [{ runId: 'http-failed-run', eventId: 'rpm-1', sampleTimeMs: 0, receivedTimeMs: 0, sequence: 1, sensor: 'rpm', value: 800, unit: 'rpm' }],
    calibrations: [],
    performance: {
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
    },
  }, 'http-failed-analysis');

  assert.equal(response.status, 422);
  assert.equal(response.payload.error.code, 'ANALYSIS_STAGE_FAILED');
  assert.equal(response.payload.error.details.failedStage, 'calibration');
  assert.deepEqual(response.payload.error.details.completedStages, ['replay']);
  assert.equal(response.payload.error.details.originalError.code, 'CALIBRATION_MISSING');
  assert.deepEqual(response.payload.error.details.partialReport.telemetry, { received: 1, replayed: 1, calibrated: 0 });
});
