import { Schema } from "effect";

const IsoDate = Schema.String;
const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Positive = Schema.Number.check(Schema.isGreaterThan(0));
const PositiveInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const SignalCode = Schema.Literals([
  "auth_unavailable",
  "checkout_unavailable",
  "content_unavailable",
  "database_unavailable",
  "email_unavailable",
  "learner_flow_unavailable",
  "subscribe_to_shadow_newsletter_sequence_paused",
  "web_unavailable",
]);
const SummaryCode = Schema.Literals([
  "auth_probe_failed",
  "auth_probe_passed",
  "auth_probe_unknown",
  "checkout_probe_failed",
  "checkout_probe_passed",
  "checkout_probe_unknown",
  "content_probe_failed",
  "content_probe_passed",
  "content_probe_unknown",
  "database_probe_failed",
  "database_probe_passed",
  "database_probe_unknown",
  "email_probe_failed",
  "email_probe_passed",
  "email_probe_unknown",
  "learner_flow_probe_failed",
  "learner_flow_probe_passed",
  "learner_flow_probe_unknown",
  "shadow_newsletter_sequence_paused",
  "web_probe_failed",
  "web_probe_passed",
  "web_probe_unknown",
]);

export const DetectorEventV1 = Schema.Struct({
  schemaVersion: Schema.Literal("aih.status.detector-event.v1"),
  eventId: Schema.NonEmptyString,
  idempotencyKey: Schema.NonEmptyString,
  detectorId: Schema.NonEmptyString,
  detectorKind: Schema.Literals([
    "first_party_probe",
    "provider_status",
    "axiom_monitor",
    "synthetic",
  ]),
  target: Schema.Literals([
    "web",
    "auth",
    "checkout",
    "content",
    "learner_flow",
    "database",
    "email",
  ]),
  observedAt: IsoDate,
  sequence: NonNegativeInt,
  signal: Schema.Struct({
    state: Schema.Literals(["pass", "fail", "unknown"]),
    severity: Schema.Literals(["info", "degraded", "outage"]),
    code: SignalCode,
  }),
  sample: Schema.Struct({
    windowSeconds: PositiveInt,
    passed: NonNegativeInt,
    failed: NonNegativeInt,
    total: PositiveInt,
  }),
  evidence: Schema.Struct({
    summaryCode: SummaryCode,
    metric: Schema.optionalKey(
      Schema.Struct({
        name: Schema.NonEmptyString,
        value: Schema.Number,
        threshold: Schema.Number,
        unit: Schema.NonEmptyString,
      }),
    ),
    digest: Schema.NonEmptyString,
  }),
  privacy: Schema.Literal("aggregate_only"),
});

export type DetectorEvent = typeof DetectorEventV1.Type;

export const IncidentState = Schema.Literals([
  "healthy",
  "investigating",
  "degraded",
  "outage",
  "recovering",
  "resolved",
]);
export type IncidentState = typeof IncidentState.Type;

export const IncidentHistoryV1 = Schema.Struct({
  schemaVersion: Schema.Literal("aih.status.incident-history.v1"),
  incidentId: Schema.NonEmptyString,
  incidentVersion: Positive,
  from: IncidentState,
  to: IncidentState,
  reasonCode: Schema.NonEmptyString,
  policyVersion: Schema.NonEmptyString,
  evidenceDigest: Schema.NonEmptyString,
  observedAt: IsoDate,
});
export type IncidentHistory = typeof IncidentHistoryV1.Type;

export const IncidentSnapshotV1 = Schema.Struct({
  schemaVersion: Schema.Literal("aih.status.incident.v1"),
  incidentId: Schema.NonEmptyString,
  correlationKey: Schema.NonEmptyString,
  state: IncidentState,
  version: Positive,
  target: DetectorEventV1.fields.target,
  signalCode: Schema.NonEmptyString,
  openedAt: IsoDate,
  updatedAt: IsoDate,
  resolvedAt: Schema.optionalKey(IsoDate),
  openingDetectorFamilies: Schema.Array(DetectorEventV1.fields.detectorKind),
});
export type IncidentSnapshot = typeof IncidentSnapshotV1.Type;

export const PublicChangeProposalV1 = Schema.Struct({
  schemaVersion: Schema.Literal("aih.status.public-change.v1"),
  proposalId: Schema.NonEmptyString,
  incidentId: Schema.NonEmptyString,
  incidentVersion: Positive,
  from: Schema.Literals(["unknown", "operational", "degraded", "outage"]),
  to: Schema.Literals(["operational", "degraded", "outage"]),
  publicProjectionDigest: Schema.NonEmptyString,
  reasonCode: Schema.NonEmptyString,
  createdAt: IsoDate,
  expiresAt: IsoDate,
  nonce: Schema.NonEmptyString,
});
export type PublicChangeProposal = typeof PublicChangeProposalV1.Type;

const PublicComponent = Schema.Struct({
  key: Schema.String,
  state: Schema.Literals(["operational", "degraded", "outage", "unknown"]),
});

const PublicIncident = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["degraded", "outage", "resolved"]),
  title: Schema.String,
  summary: Schema.String,
  startedAt: IsoDate,
  updatedAt: IsoDate,
  resolvedAt: Schema.optionalKey(IsoDate),
});

export const PublicStatusV1 = Schema.Struct({
  schemaVersion: Schema.Literal("aih.status.public.v1"),
  overall: Schema.Literals(["unknown", "operational", "degraded", "outage"]),
  components: Schema.Array(PublicComponent),
  incidents: Schema.Array(PublicIncident),
  generatedAt: IsoDate,
  sourceIncidentVersion: NonNegative,
});
export type PublicStatus = typeof PublicStatusV1.Type;

export const DevinInvestigationResultV1 = Schema.Struct({
  schemaVersion: Schema.Literal("aih.status.devin-result.v1"),
  incidentId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  startedAt: IsoDate,
  completedAt: IsoDate,
  outcome: Schema.Literals(["supported", "inconclusive", "cannot_investigate"]),
  confidence: Schema.Literals(["low", "medium", "high"]),
  summaryCode: Schema.NonEmptyString,
  hypotheses: Schema.Array(
    Schema.Struct({
      statement: Schema.String,
      status: Schema.Literals(["supported", "disproved", "unverified"]),
      evidenceRefs: Schema.Array(Schema.String),
    }),
  ),
  observedFacts: Schema.Array(
    Schema.Struct({ code: Schema.String, evidenceRefs: Schema.Array(Schema.String) }),
  ),
  unknowns: Schema.Array(Schema.String),
  recommendedOperatorActions: Schema.Array(Schema.String),
  queries: Schema.Array(
    Schema.Struct({
      system: Schema.Literals(["axiom", "provider_status", "github"]),
      receiptId: Schema.String,
    }),
  ),
  limits: Schema.Struct({
    acuMax: Positive,
    elapsedSeconds: NonNegative,
    timedOut: Schema.Boolean,
  }),
  privacy: Schema.Struct({
    aggregateOnly: Schema.Literal(true),
    rawLogsIncluded: Schema.Literal(false),
    customerIdentifiersIncluded: Schema.Literal(false),
  }),
});
export type DevinInvestigationResult = typeof DevinInvestigationResultV1.Type;

const DetectorReceiptV1 = Schema.Struct({
  eventId: Schema.String,
  idempotencyKey: Schema.String,
  incidentId: Schema.optionalKey(Schema.String),
  detectorId: Schema.String,
  detectorKind: DetectorEventV1.fields.detectorKind,
  target: DetectorEventV1.fields.target,
  signalState: DetectorEventV1.fields.signal.fields.state,
  signalCode: Schema.String,
  evidenceDigest: Schema.String,
  observedAt: IsoDate,
  outcomeCode: Schema.String,
  suppressionRuleId: Schema.optionalKey(Schema.String),
});

const ApprovalReceiptV1 = Schema.Struct({
  proposalId: Schema.String,
  actor: Schema.String,
  outcomeCode: Schema.String,
  observedAt: IsoDate,
});

const ProposalDeliveryReceiptV1 = Schema.Struct({
  proposalId: Schema.String,
  receiptId: Schema.String,
  destination: Schema.Literal("tracer_status_channel"),
  createdAt: IsoDate,
});

export const AdminStatusV1 = Schema.Struct({
  schemaVersion: Schema.Literal("aih.status.admin.v1"),
  generatedAt: IsoDate,
  publicStatus: PublicStatusV1,
  incidents: Schema.Array(IncidentSnapshotV1),
  history: Schema.Array(IncidentHistoryV1),
  proposals: Schema.Array(PublicChangeProposalV1),
  investigations: Schema.Array(DevinInvestigationResultV1),
  detectorReceipts: Schema.Array(DetectorReceiptV1),
  approvalReceipts: Schema.Array(ApprovalReceiptV1),
  proposalDeliveries: Schema.Array(ProposalDeliveryReceiptV1),
  switches: Schema.Struct({
    automationEnabled: Schema.Boolean,
    publicWritesEnabled: Schema.Boolean,
  }),
});
export type AdminStatus = typeof AdminStatusV1.Type;

const strictOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const canonicalUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const opaqueValue = /^[A-Za-z0-9._:-]{1,200}$/;

function assertDetectorSemantics(event: DetectorEvent): DetectorEvent {
  if (!canonicalUtc.test(event.observedAt) || !Number.isFinite(Date.parse(event.observedAt))) {
    throw new Error("observedAt must be a canonical UTC timestamp");
  }
  if (event.sample.passed + event.sample.failed > event.sample.total) {
    throw new Error("sample counts exceed total");
  }
  for (const value of [
    event.eventId,
    event.idempotencyKey,
    event.detectorId,
    event.evidence.digest,
    ...(event.evidence.metric ? [event.evidence.metric.name, event.evidence.metric.unit] : []),
  ]) {
    if (!opaqueValue.test(value)) {
      throw new Error("detector identifiers and evidence must be opaque machine values");
    }
  }
  return event;
}

function assertDevinSemantics(result: DevinInvestigationResult): DevinInvestigationResult {
  if (
    !canonicalUtc.test(result.startedAt) ||
    !canonicalUtc.test(result.completedAt) ||
    Date.parse(result.completedAt) < Date.parse(result.startedAt)
  ) {
    throw new Error("investigation timestamps are invalid");
  }
  const machineValues = [
    result.incidentId,
    result.sessionId,
    result.summaryCode,
    ...result.hypotheses.flatMap((item) => [item.statement, ...item.evidenceRefs]),
    ...result.observedFacts.flatMap((item) => [item.code, ...item.evidenceRefs]),
    ...result.unknowns,
    ...result.recommendedOperatorActions,
    ...result.queries.map((item) => item.receiptId),
  ];
  if (machineValues.some((value) => !opaqueValue.test(value))) {
    throw new Error("investigation output must contain only opaque machine values");
  }
  return result;
}

export const decodeDetectorEvent = (input: unknown): DetectorEvent =>
  assertDetectorSemantics(Schema.decodeUnknownSync(DetectorEventV1, strictOptions)(input));
export const decodeDevinResult = (input: unknown): DevinInvestigationResult =>
  assertDevinSemantics(Schema.decodeUnknownSync(DevinInvestigationResultV1, strictOptions)(input));
export const decodePublicStatus = (input: unknown): PublicStatus =>
  Schema.decodeUnknownSync(PublicStatusV1, strictOptions)(input);
