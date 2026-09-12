export const detectorEvent = {
  schemaVersion: "aih.status.detector-event.v1",
  eventId: "evt-db-001",
  idempotencyKey: "idem-db-001",
  detectorId: "database-probe-a",
  detectorKind: "first_party_probe",
  target: "database",
  observedAt: "2026-08-10T10:00:00.000Z",
  sequence: 1,
  signal: {
    state: "fail",
    severity: "outage",
    code: "database_unavailable",
  },
  sample: {
    windowSeconds: 300,
    passed: 0,
    failed: 1,
    total: 1,
  },
  evidence: {
    summaryCode: "database_probe_failed",
    digest: "sha256:aggregate-db-001",
  },
  privacy: "aggregate_only",
} as const;
