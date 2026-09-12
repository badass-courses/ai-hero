import {
  AdminStatusV1,
  DetectorEventV1,
  IncidentSnapshotV1,
  IncidentState as IncidentStateSchema,
  PublicChangeProposalV1,
  decodeDetectorEvent,
  decodeDevinResult,
  decodePublicStatus,
  type AdminStatus,
  type DetectorEvent,
  type IncidentHistory,
  type IncidentSnapshot,
  type PublicChangeProposal,
  type PublicStatus,
} from "../contracts/index";
import { Schema } from "effect";
import { fakeSlackAdapter } from "../approvals/fake-delivery";
import {
  decodeFakeApproval,
  STATUS_OPERATOR_ALLOWLIST,
  type FakeApproval,
} from "../approvals/fake-approval";
import { transitionIncident } from "../incident/machine";
import {
  TRACER_POLICY,
  classifyFailure,
  correlationBase,
  evaluateRecovery,
  findSuppression,
  hasProposalAgreement,
  stableDigest,
} from "../incident/policy";
import { fakeDevinAdapter, validateFakeDevinResult } from "../investigations/fake-devin";
import { buildPublicProjection, unknownStatus } from "../projections/index";

type IncidentRow = {
  incident_id: string;
  correlation_base: string;
  state: IncidentSnapshot["state"];
  version: number;
  target: IncidentSnapshot["target"];
  signal_code: string;
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
  opening_families_json: string;
  opening_detector_ids_json: string;
};

type EventRow = { payload_json: string; outcome_json: string };
type JsonRow = { value: string };
type ProposalRow = {
  proposal_json: string;
  projection_json: string;
  used_at: string | null;
};

const IngestOutcomeSchema = Schema.Struct({
  accepted: Schema.Literal(true),
  replayed: Schema.Boolean,
  suppressed: Schema.Boolean,
  outcomeCode: Schema.String,
  incidentId: Schema.optionalKey(Schema.String),
  incidentVersion: Schema.optionalKey(Schema.Number),
  state: IncidentStateSchema,
  transition: Schema.NullOr(Schema.Struct({ from: IncidentStateSchema, to: IncidentStateSchema })),
  investigationCreated: Schema.Boolean,
  proposalId: Schema.optionalKey(Schema.String),
});
export type IngestOutcome = typeof IngestOutcomeSchema.Type;
export type IngestRejection = {
  accepted: false;
  replayed: false;
  outcomeCode: "backdated_event" | "idempotency_conflict";
  state: IncidentSnapshot["state"];
  incidentId?: string;
  incidentVersion?: number;
};
export type IngestResult = IngestOutcome | IngestRejection;

export type ApprovalOutcome = {
  ok: boolean;
  code: string;
  publicStatus?: PublicStatus;
};

const rows = <T>(cursor: Iterable<T>): T[] => Array.from(cursor);
const parseStringArray = (value: string): readonly string[] =>
  Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(value));
const parseDetectorFamilies = (value: string): readonly DetectorEvent["detectorKind"][] =>
  Schema.decodeUnknownSync(Schema.Array(DetectorEventV1.fields.detectorKind))(JSON.parse(value));

export class IncidentStore implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        incident_id TEXT PRIMARY KEY,
        correlation_base TEXT NOT NULL,
        open_key TEXT UNIQUE,
        state TEXT NOT NULL,
        version INTEGER NOT NULL,
        target TEXT NOT NULL,
        signal_code TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        opening_families_json TEXT NOT NULL,
        opening_detector_ids_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS incidents_correlation ON incidents(correlation_base, open_key);
      CREATE TABLE IF NOT EXISTS detector_events (
        event_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        incident_id TEXT,
        detector_id TEXT NOT NULL,
        detector_kind TEXT NOT NULL,
        target TEXT NOT NULL,
        signal_state TEXT NOT NULL,
        signal_code TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        suppression_rule_id TEXT,
        outcome_code TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        outcome_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS detector_events_incident ON detector_events(incident_id, observed_at);
      CREATE TABLE IF NOT EXISTS incident_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id TEXT NOT NULL,
        incident_version INTEGER NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigations (
        incident_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposals (
        proposal_id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        incident_version INTEGER NOT NULL,
        to_status TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        proposal_json TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        used_at TEXT,
        used_by TEXT,
        UNIQUE(incident_id, incident_version)
      );
      CREATE TABLE IF NOT EXISTS proposal_deliveries (
        proposal_id TEXT PRIMARY KEY,
        receipt_id TEXT NOT NULL UNIQUE,
        destination TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS public_projections (
        projection_version INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT UNIQUE,
        digest TEXT NOT NULL,
        published_at TEXT NOT NULL,
        status_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approval_receipts (
        receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        outcome_code TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/event") {
        const event = decodeDetectorEvent(await request.json());
        const result = this.ingest(event, {
          automationEnabled: request.headers.get("x-automation-enabled") === "true",
        });
        return Response.json(result, { status: result.accepted ? 200 : 409 });
      }
      if (request.method === "POST" && url.pathname === "/approval") {
        const approval = decodeFakeApproval(await request.json());
        return Response.json(
          this.approve(approval, {
            publicWritesEnabled: request.headers.get("x-public-writes-enabled") === "true",
          }),
        );
      }
      if (request.method === "POST" && url.pathname === "/investigation") {
        return Response.json(this.attachInvestigation(await request.json()));
      }
      if (request.method === "GET" && url.pathname === "/public") {
        return Response.json(this.publicStatus(new Date().toISOString()));
      }
      if (request.method === "GET" && url.pathname === "/admin") {
        return Response.json(
          this.adminStatus(new Date().toISOString(), {
            automationEnabled: request.headers.get("x-automation-enabled") === "true",
            publicWritesEnabled: request.headers.get("x-public-writes-enabled") === "true",
          }),
        );
      }
      return new Response("Not found", { status: 404 });
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
  }

  private currentPublic(now: string): PublicStatus {
    const current = rows(
      this.sql.exec<JsonRow>(
        "SELECT status_json AS value FROM public_projections ORDER BY projection_version DESC LIMIT 1",
      ),
    )[0];
    return current ? decodePublicStatus(JSON.parse(current.value)) : unknownStatus(now);
  }

  publicStatus(now: string): PublicStatus {
    return this.currentPublic(now);
  }

  private incidentFromRow(row: IncidentRow): IncidentSnapshot {
    return Schema.decodeUnknownSync(IncidentSnapshotV1, { onExcessProperty: "error" })({
      schemaVersion: "aih.status.incident.v1",
      incidentId: row.incident_id,
      correlationKey: row.correlation_base,
      state: row.state,
      version: row.version,
      target: row.target,
      signalCode: row.signal_code,
      openedAt: row.opened_at,
      updatedAt: row.updated_at,
      ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
      openingDetectorFamilies: parseDetectorFamilies(row.opening_families_json),
    });
  }

  private findOpenIncident(event: DetectorEvent): IncidentRow | undefined {
    return rows(
      this.sql.exec<IncidentRow>(
        "SELECT * FROM incidents WHERE target = ? AND signal_code = ? AND open_key IS NOT NULL LIMIT 1",
        event.target,
        event.signal.code,
      ),
    )[0];
  }

  private eventsForIncident(incidentId: string): DetectorEvent[] {
    return rows(
      this.sql.exec<EventRow>(
        "SELECT payload_json, outcome_json FROM detector_events WHERE incident_id = ? ORDER BY observed_at, event_id",
        incidentId,
      ),
    ).map((row) => decodeDetectorEvent(JSON.parse(row.payload_json)));
  }

  ingest(event: DetectorEvent, switches: { automationEnabled: boolean }): IngestResult {
    return this.ctx.storage.transactionSync(() => {
      const replay = rows(
        this.sql.exec<EventRow>(
          "SELECT payload_json, outcome_json FROM detector_events WHERE event_id = ? OR idempotency_key = ? LIMIT 1",
          event.eventId,
          event.idempotencyKey,
        ),
      )[0];
      if (replay) {
        const stored = Schema.decodeUnknownSync(IngestOutcomeSchema, {
          onExcessProperty: "error",
        })(JSON.parse(replay.outcome_json));
        if (replay.payload_json !== JSON.stringify(event)) {
          return {
            accepted: false,
            replayed: false,
            outcomeCode: "idempotency_conflict",
            state: stored.state,
            ...(stored.incidentId ? { incidentId: stored.incidentId } : {}),
            ...(stored.incidentVersion ? { incidentVersion: stored.incidentVersion } : {}),
          };
        }
        return { ...stored, replayed: true };
      }

      const suppression = findSuppression(event);
      if (suppression) {
        const outcome: IngestOutcome = {
          accepted: true,
          replayed: false,
          suppressed: true,
          outcomeCode: "suppressed_exact_rule",
          state: "healthy",
          transition: null,
          investigationCreated: false,
        };
        this.insertEvent(event, outcome, null, suppression.id);
        return outcome;
      }

      const base = correlationBase(event);
      let row = this.findOpenIncident(event);
      if (!row && event.signal.state !== "fail") {
        const outcome: IngestOutcome = {
          accepted: true,
          replayed: false,
          suppressed: false,
          outcomeCode:
            event.signal.state === "unknown"
              ? "unknown_without_incident"
              : "passing_without_incident",
          state: "healthy",
          transition: null,
          investigationCreated: false,
        };
        this.insertEvent(event, outcome, null, null);
        return outcome;
      }

      if (row && Date.parse(event.observedAt) < Date.parse(row.updated_at)) {
        return {
          accepted: false,
          replayed: false,
          outcomeCode: "backdated_event",
          state: row.state,
          incidentId: row.incident_id,
          incidentVersion: row.version,
        };
      }

      if (!row) {
        const incidentId = `inc-${stableDigest(`${base}:${event.eventId}:${event.observedAt}`)}`;
        const transition = transitionIncident("healthy", { type: "FAILURE" });
        row = {
          incident_id: incidentId,
          correlation_base: base,
          state: transition.state,
          version: 1,
          target: event.target,
          signal_code: event.signal.code,
          opened_at: event.observedAt,
          updated_at: event.observedAt,
          resolved_at: null,
          opening_families_json: JSON.stringify([event.detectorKind]),
          opening_detector_ids_json: JSON.stringify([event.detectorId]),
        };
        this.sql.exec(
          "INSERT INTO incidents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
          row.incident_id,
          row.correlation_base,
          row.correlation_base,
          row.state,
          row.version,
          row.target,
          row.signal_code,
          row.opened_at,
          row.updated_at,
          row.opening_families_json,
          row.opening_detector_ids_json,
        );
        this.insertHistory(row, "healthy", row.state, "first_failure_candidate", event);
        const outcome: IngestOutcome = {
          accepted: true,
          replayed: false,
          suppressed: false,
          outcomeCode: "incident_opened",
          incidentId,
          incidentVersion: 1,
          state: row.state,
          transition: { from: "healthy", to: row.state },
          investigationCreated: false,
        };
        this.insertEvent(event, outcome, incidentId, null);
        return outcome;
      }

      const from = row.state;
      const incidentEvents = [...this.eventsForIncident(row.incident_id), event];
      const openingFamilies = new Set(parseDetectorFamilies(row.opening_families_json));
      const openingDetectorIds = new Set(parseStringArray(row.opening_detector_ids_json));
      if (event.signal.state === "fail") {
        openingFamilies.add(event.detectorKind);
        openingDetectorIds.add(event.detectorId);
      }

      let next = { state: from, changed: false };
      let reasonCode = "evidence_recorded";
      if (event.signal.state === "fail") {
        const classification = classifyFailure(incidentEvents, event.observedAt);
        next = transitionIncident(from, { type: "EVALUATE", classification });
        reasonCode = next.changed
          ? `${classification}_threshold_met`
          : `${classification}_evidence_recorded`;
      } else {
        const recovery = evaluateRecovery(
          incidentEvents,
          [...openingFamilies],
          [...openingDetectorIds],
        );
        if ((from === "degraded" || from === "outage") && recovery.entry) {
          next = transitionIncident(from, { type: "RECOVERY_READY" });
          reasonCode = "recovery_entry_guard_met";
        } else if (from === "recovering" && recovery.resolved) {
          next = transitionIncident(from, { type: "RESOLUTION_READY" });
          reasonCode = "resolution_guard_met";
        } else if (from === "investigating") {
          const opened = Date.parse(row.opened_at);
          if (Date.parse(event.observedAt) - opened > TRACER_POLICY.windowMs) {
            next = transitionIncident(from, { type: "WINDOW_CLOSED" });
            reasonCode = "candidate_window_closed";
          }
        }
      }

      const version = row.version + (next.changed ? 1 : 0);
      const resolvedAt = next.state === "resolved" ? event.observedAt : row.resolved_at;
      const openKey =
        next.state === "resolved" || next.state === "healthy" ? null : row.correlation_base;
      this.sql.exec(
        "UPDATE incidents SET open_key = ?, state = ?, version = ?, updated_at = ?, resolved_at = ?, opening_families_json = ?, opening_detector_ids_json = ? WHERE incident_id = ?",
        openKey,
        next.state,
        version,
        event.observedAt,
        resolvedAt,
        JSON.stringify([...openingFamilies]),
        JSON.stringify([...openingDetectorIds]),
        row.incident_id,
      );
      row = {
        ...row,
        state: next.state,
        version,
        updated_at: event.observedAt,
        resolved_at: resolvedAt,
        opening_families_json: JSON.stringify([...openingFamilies]),
        opening_detector_ids_json: JSON.stringify([...openingDetectorIds]),
      };
      this.insertHistory(row, from, next.state, reasonCode, event);

      let investigationCreated = false;
      let proposalId: string | undefined;
      if (switches.automationEnabled && next.changed) {
        if (next.state === "degraded" || next.state === "outage") {
          investigationCreated = this.ensureFakeInvestigation(row, event);
          if (hasProposalAgreement(incidentEvents, event.observedAt)) {
            proposalId = this.ensureProposal(
              row,
              next.state,
              reasonCode,
              event.observedAt,
            )?.proposalId;
          }
        } else if (next.state === "resolved") {
          proposalId = this.ensureProposal(
            row,
            "operational",
            reasonCode,
            event.observedAt,
          )?.proposalId;
        }
      }

      const outcome: IngestOutcome = {
        accepted: true,
        replayed: false,
        suppressed: false,
        outcomeCode: reasonCode,
        incidentId: row.incident_id,
        incidentVersion: version,
        state: next.state,
        transition: next.changed ? { from, to: next.state } : null,
        investigationCreated,
        ...(proposalId ? { proposalId } : {}),
      };
      this.insertEvent(event, outcome, row.incident_id, null);
      return outcome;
    });
  }

  private insertEvent(
    event: DetectorEvent,
    outcome: IngestOutcome,
    incidentId: string | null,
    suppressionRuleId: string | null,
  ): void {
    this.sql.exec(
      "INSERT INTO detector_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      event.eventId,
      event.idempotencyKey,
      incidentId,
      event.detectorId,
      event.detectorKind,
      event.target,
      event.signal.state,
      event.signal.code,
      event.evidence.digest,
      event.observedAt,
      suppressionRuleId,
      outcome.outcomeCode,
      JSON.stringify(event),
      JSON.stringify(outcome),
    );
  }

  private insertHistory(
    row: IncidentRow,
    from: IncidentSnapshot["state"],
    to: IncidentSnapshot["state"],
    reasonCode: string,
    event: DetectorEvent,
  ): void {
    this.sql.exec(
      "INSERT INTO incident_history (incident_id, incident_version, from_state, to_state, reason_code, policy_version, evidence_digest, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      row.incident_id,
      row.version,
      from,
      to,
      reasonCode,
      TRACER_POLICY.version,
      event.evidence.digest,
      event.observedAt,
    );
  }

  private ensureFakeInvestigation(row: IncidentRow, event: DetectorEvent): boolean {
    const existing = rows(
      this.sql.exec<{ incident_id: string }>(
        "SELECT incident_id FROM investigations WHERE incident_id = ?",
        row.incident_id,
      ),
    )[0];
    if (existing) return false;
    const since = new Date(Date.parse(event.observedAt) - 60 * 60 * 1000).toISOString();
    const count =
      rows(
        this.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM investigations WHERE created_at >= ?",
          since,
        ),
      )[0]?.count ?? 0;
    if (count >= TRACER_POLICY.fakeInvestigationHourlyCap) return false;
    const result = fakeDevinAdapter.investigate({
      incidentId: row.incident_id,
      startedAt: event.observedAt,
      evidenceDigest: event.evidence.digest,
    });
    this.sql.exec(
      "INSERT INTO investigations VALUES (?, ?, ?, ?)",
      row.incident_id,
      result.sessionId,
      event.observedAt,
      JSON.stringify(result),
    );
    return true;
  }

  attachInvestigation(input: unknown): { ok: boolean; code: string } {
    const result = validateFakeDevinResult(input);
    return this.ctx.storage.transactionSync(() => {
      const incident = rows(
        this.sql.exec<{ incident_id: string }>(
          "SELECT incident_id FROM incidents WHERE incident_id = ?",
          result.incidentId,
        ),
      )[0];
      if (!incident) return { ok: false, code: "incident_not_found" };
      const existing = rows(
        this.sql.exec<{ incident_id: string }>(
          "SELECT incident_id FROM investigations WHERE incident_id = ?",
          result.incidentId,
        ),
      )[0];
      if (existing) return { ok: false, code: "investigation_already_attached" };
      this.sql.exec(
        "INSERT INTO investigations VALUES (?, ?, ?, ?)",
        result.incidentId,
        result.sessionId,
        result.startedAt,
        JSON.stringify(result),
      );
      return { ok: true, code: "investigation_attached" };
    });
  }

  private ensureProposal(
    row: IncidentRow,
    to: "operational" | "degraded" | "outage",
    reasonCode: string,
    now: string,
  ): PublicChangeProposal | undefined {
    const existing = rows(
      this.sql.exec<ProposalRow>(
        "SELECT proposal_json, projection_json, used_at FROM proposals WHERE incident_id = ? AND incident_version = ? AND to_status = ?",
        row.incident_id,
        row.version,
        to,
      ),
    )[0];
    if (existing) {
      return Schema.decodeUnknownSync(PublicChangeProposalV1)(JSON.parse(existing.proposal_json));
    }
    const incident = this.incidentFromRow(row);
    const current = this.currentPublic(now);
    const projection = buildPublicProjection(current, incident, to, now);
    const digest = stableDigest(JSON.stringify(projection));
    const proposalId = `proposal-${stableDigest(`${row.incident_id}:${row.version}:${to}`)}`;
    const nonce = `nonce-${stableDigest(`${proposalId}:${digest}`)}`;
    const proposal: PublicChangeProposal = {
      schemaVersion: "aih.status.public-change.v1",
      proposalId,
      incidentId: row.incident_id,
      incidentVersion: row.version,
      from: current.overall,
      to,
      publicProjectionDigest: digest,
      reasonCode,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + TRACER_POLICY.proposalTtlMs).toISOString(),
      nonce,
    };
    this.sql.exec(
      "INSERT INTO proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
      proposalId,
      row.incident_id,
      row.version,
      to,
      nonce,
      digest,
      now,
      proposal.expiresAt,
      JSON.stringify(proposal),
      JSON.stringify(projection),
    );
    const delivery = fakeSlackAdapter.deliver(proposal);
    this.sql.exec(
      "INSERT INTO proposal_deliveries VALUES (?, ?, ?, ?)",
      delivery.proposalId,
      delivery.receiptId,
      delivery.destination,
      delivery.createdAt,
    );
    return proposal;
  }

  approve(approval: FakeApproval, switches: { publicWritesEnabled: boolean }): ApprovalOutcome {
    return this.ctx.storage.transactionSync(() => {
      let code = "approval_rejected";
      let publicStatus: PublicStatus | undefined;
      const proposalRow = rows(
        this.sql.exec<ProposalRow>(
          "SELECT proposal_json, projection_json, used_at FROM proposals WHERE proposal_id = ?",
          approval.proposalId,
        ),
      )[0];
      const proposal = proposalRow
        ? Schema.decodeUnknownSync(PublicChangeProposalV1)(JSON.parse(proposalRow.proposal_json))
        : undefined;

      if (!switches.publicWritesEnabled) code = "public_writes_disabled";
      else if (!approval.signatureValid) code = "invalid_signature";
      else if (!STATUS_OPERATOR_ALLOWLIST.has(approval.actor)) code = "actor_not_allowed";
      else if (!proposal || !proposalRow) code = "proposal_not_found";
      else if (proposalRow.used_at) code = "nonce_replayed";
      else if (Date.parse(approval.observedAt) > Date.parse(proposal.expiresAt))
        code = "proposal_expired";
      else if (approval.nonce !== proposal.nonce) code = "nonce_mismatch";
      else if (approval.incidentVersion !== proposal.incidentVersion)
        code = "stale_incident_version";
      else if (approval.publicProjectionDigest !== proposal.publicProjectionDigest)
        code = "digest_mismatch";
      else {
        const currentIncident = rows(
          this.sql.exec<{ version: number }>(
            "SELECT version FROM incidents WHERE incident_id = ?",
            proposal.incidentId,
          ),
        )[0];
        if (!currentIncident || currentIncident.version !== proposal.incidentVersion) {
          code = "stale_incident_version";
        } else {
          publicStatus = decodePublicStatus(JSON.parse(proposalRow.projection_json));
          this.sql.exec(
            "UPDATE proposals SET used_at = ?, used_by = ? WHERE proposal_id = ? AND used_at IS NULL",
            approval.observedAt,
            approval.actor,
            approval.proposalId,
          );
          this.sql.exec(
            "INSERT INTO public_projections (proposal_id, digest, published_at, status_json) VALUES (?, ?, ?, ?)",
            approval.proposalId,
            proposal.publicProjectionDigest,
            approval.observedAt,
            JSON.stringify(publicStatus),
          );
          code = "published";
        }
      }

      this.sql.exec(
        "INSERT INTO approval_receipts (proposal_id, actor, outcome_code, observed_at) VALUES (?, ?, ?, ?)",
        approval.proposalId,
        STATUS_OPERATOR_ALLOWLIST.has(approval.actor) ? approval.actor : "untrusted_actor",
        code,
        approval.observedAt,
      );
      return { ok: code === "published", code, ...(publicStatus ? { publicStatus } : {}) };
    });
  }

  adminStatus(
    now: string,
    switches: { automationEnabled: boolean; publicWritesEnabled: boolean },
  ): AdminStatus {
    const incidents = rows(
      this.sql.exec<IncidentRow>("SELECT * FROM incidents ORDER BY opened_at"),
    ).map((row) => this.incidentFromRow(row));
    const history: IncidentHistory[] = rows(
      this.sql.exec<{
        incident_id: string;
        incident_version: number;
        from_state: IncidentSnapshot["state"];
        to_state: IncidentSnapshot["state"];
        reason_code: string;
        policy_version: string;
        evidence_digest: string;
        observed_at: string;
      }>("SELECT * FROM incident_history ORDER BY history_id"),
    ).map((row) => ({
      schemaVersion: "aih.status.incident-history.v1",
      incidentId: row.incident_id,
      incidentVersion: row.incident_version,
      from: row.from_state,
      to: row.to_state,
      reasonCode: row.reason_code,
      policyVersion: row.policy_version,
      evidenceDigest: row.evidence_digest,
      observedAt: row.observed_at,
    }));
    const proposals = rows(
      this.sql.exec<{ value: string }>(
        "SELECT proposal_json AS value FROM proposals ORDER BY created_at, proposal_id",
      ),
    ).map((row) => Schema.decodeUnknownSync(PublicChangeProposalV1)(JSON.parse(row.value)));
    const investigations = rows(
      this.sql.exec<{ value: string }>(
        "SELECT result_json AS value FROM investigations ORDER BY created_at, session_id",
      ),
    ).map((row) => decodeDevinResult(JSON.parse(row.value)));
    const detectorReceipts = rows(
      this.sql.exec<{
        event_id: string;
        idempotency_key: string;
        incident_id: string | null;
        detector_id: string;
        detector_kind: DetectorEvent["detectorKind"];
        target: DetectorEvent["target"];
        signal_state: DetectorEvent["signal"]["state"];
        signal_code: string;
        evidence_digest: string;
        observed_at: string;
        outcome_code: string;
        suppression_rule_id: string | null;
      }>("SELECT * FROM detector_events ORDER BY observed_at, event_id"),
    ).map((row) => ({
      eventId: row.event_id,
      idempotencyKey: row.idempotency_key,
      ...(row.incident_id ? { incidentId: row.incident_id } : {}),
      detectorId: row.detector_id,
      detectorKind: row.detector_kind,
      target: row.target,
      signalState: row.signal_state,
      signalCode: row.signal_code,
      evidenceDigest: row.evidence_digest,
      observedAt: row.observed_at,
      outcomeCode: row.outcome_code,
      ...(row.suppression_rule_id ? { suppressionRuleId: row.suppression_rule_id } : {}),
    }));
    const approvalReceipts = rows(
      this.sql.exec<{
        proposal_id: string;
        actor: string;
        outcome_code: string;
        observed_at: string;
      }>(
        "SELECT proposal_id, actor, outcome_code, observed_at FROM approval_receipts ORDER BY receipt_id",
      ),
    ).map((row) => ({
      proposalId: row.proposal_id,
      actor: row.actor,
      outcomeCode: row.outcome_code,
      observedAt: row.observed_at,
    }));
    const proposalDeliveries = rows(
      this.sql.exec<{
        proposal_id: string;
        receipt_id: string;
        destination: "tracer_status_channel";
        created_at: string;
      }>(
        "SELECT proposal_id, receipt_id, destination, created_at FROM proposal_deliveries ORDER BY created_at, proposal_id",
      ),
    ).map((row) => ({
      proposalId: row.proposal_id,
      receiptId: row.receipt_id,
      destination: row.destination,
      createdAt: row.created_at,
    }));

    return Schema.decodeUnknownSync(AdminStatusV1, { onExcessProperty: "error" })({
      schemaVersion: "aih.status.admin.v1",
      generatedAt: now,
      publicStatus: this.currentPublic(now),
      incidents,
      history,
      proposals,
      investigations,
      detectorReceipts,
      approvalReceipts,
      proposalDeliveries,
      switches,
    });
  }
}
