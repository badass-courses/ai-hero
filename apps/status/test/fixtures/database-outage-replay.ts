import type { DetectorEvent } from "../../src/contracts/index";

const base = {
  schemaVersion: "aih.status.detector-event.v1",
  target: "database",
  signal: {
    state: "fail",
    severity: "outage",
    code: "database_unavailable",
  },
  sample: { windowSeconds: 300, passed: 0, failed: 1, total: 1 },
  privacy: "aggregate_only",
} as const;

export function databaseEvent(input: {
  id: string;
  at: string;
  detectorId: string;
  detectorKind: DetectorEvent["detectorKind"];
  state?: DetectorEvent["signal"]["state"];
  sequence: number;
}): DetectorEvent {
  const state = input.state ?? "fail";
  return {
    ...base,
    eventId: `synthetic-${input.id}`,
    idempotencyKey: `synthetic-idem-${input.id}`,
    detectorId: input.detectorId,
    detectorKind: input.detectorKind,
    observedAt: input.at,
    sequence: input.sequence,
    signal: {
      ...base.signal,
      state,
      severity: state === "pass" ? "info" : "outage",
    },
    sample: {
      windowSeconds: 300,
      passed: state === "pass" ? 1 : 0,
      failed: state === "fail" ? 1 : 0,
      total: 1,
    },
    evidence: {
      summaryCode: state === "pass" ? "database_probe_passed" : "database_probe_failed",
      digest: `evidence:aggregate:${input.id}`,
    },
    privacy: "aggregate_only",
  };
}

export const openingEvents = [
  databaseEvent({
    id: "fail-1",
    at: "2026-08-10T10:00:00.000Z",
    detectorId: "database-probe-a",
    detectorKind: "first_party_probe",
    sequence: 1,
  }),
  databaseEvent({
    id: "fail-2",
    at: "2026-08-10T10:02:00.000Z",
    detectorId: "database-probe-b",
    detectorKind: "first_party_probe",
    sequence: 2,
  }),
  databaseEvent({
    id: "fail-3",
    at: "2026-08-10T10:03:00.000Z",
    detectorId: "database-synthetic",
    detectorKind: "synthetic",
    sequence: 3,
  }),
] as const;

export const recoveryEvents = [
  databaseEvent({
    id: "pass-a-1",
    at: "2026-08-10T10:05:00.000Z",
    detectorId: "database-probe-a",
    detectorKind: "first_party_probe",
    state: "pass",
    sequence: 4,
  }),
  databaseEvent({
    id: "pass-s-1",
    at: "2026-08-10T10:05:00.000Z",
    detectorId: "database-synthetic",
    detectorKind: "synthetic",
    state: "pass",
    sequence: 4,
  }),
  databaseEvent({
    id: "pass-a-2",
    at: "2026-08-10T10:06:00.000Z",
    detectorId: "database-probe-a",
    detectorKind: "first_party_probe",
    state: "pass",
    sequence: 5,
  }),
  databaseEvent({
    id: "pass-s-2",
    at: "2026-08-10T10:06:00.000Z",
    detectorId: "database-synthetic",
    detectorKind: "synthetic",
    state: "pass",
    sequence: 5,
  }),
  databaseEvent({
    id: "pass-a-3",
    at: "2026-08-10T10:10:00.000Z",
    detectorId: "database-probe-a",
    detectorKind: "first_party_probe",
    state: "pass",
    sequence: 6,
  }),
  databaseEvent({
    id: "pass-s-3",
    at: "2026-08-10T10:10:00.000Z",
    detectorId: "database-synthetic",
    detectorKind: "synthetic",
    state: "pass",
    sequence: 6,
  }),
  databaseEvent({
    id: "pass-independent",
    at: "2026-08-10T10:10:30.000Z",
    detectorId: "database-provider-check",
    detectorKind: "provider_status",
    state: "pass",
    sequence: 1,
  }),
] as const;
