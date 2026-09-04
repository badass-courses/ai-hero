import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AdminStatus, DetectorEvent, PublicChangeProposal } from "../../src/contracts/index";
import { databaseEvent } from "../fixtures/database-outage-replay";

const doFetch = async (
  name: string,
  path: string,
  body?: unknown,
  flags: { automation?: boolean; publicWrites?: boolean } = {},
): Promise<Response> =>
  env.INCIDENTS.getByName(name).fetch(`https://store${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-automation-enabled": String(flags.automation ?? true),
      "x-public-writes-enabled": String(flags.publicWrites ?? true),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const admin = async (name: string): Promise<AdminStatus> =>
  (await (await doFetch(name, "/admin")).json()) as AdminStatus;

const approvalFor = (proposal: PublicChangeProposal, observedAt: string) => ({
  schemaVersion: "aih.status.fake-approval.v1",
  proposalId: proposal.proposalId,
  nonce: proposal.nonce,
  actor: "status-operator-1",
  incidentVersion: proposal.incidentVersion,
  publicProjectionDigest: proposal.publicProjectionDigest,
  observedAt,
  signatureValid: true,
});

const targetEvent = (input: {
  id: string;
  at: string;
  target: DetectorEvent["target"];
  signalCode: DetectorEvent["signal"]["code"];
  summaryCode: DetectorEvent["evidence"]["summaryCode"];
  detectorId: string;
  detectorKind: DetectorEvent["detectorKind"];
  state?: DetectorEvent["signal"]["state"];
  sequence: number;
}): DetectorEvent => {
  const source = databaseEvent({
    id: input.id,
    at: input.at,
    detectorId: input.detectorId,
    detectorKind: input.detectorKind,
    ...(input.state ? { state: input.state } : {}),
    sequence: input.sequence,
  });
  return {
    ...source,
    target: input.target,
    signal: { ...source.signal, code: input.signalCode },
    evidence: { ...source.evidence, summaryCode: input.summaryCode },
  };
};

describe("SQLite Durable Object store", () => {
  it("serializes concurrent retries into one event and history row", async () => {
    const event = databaseEvent({
      id: "concurrent",
      at: "2026-08-10T10:00:00.000Z",
      detectorId: "database-probe-a",
      detectorKind: "first_party_probe",
      sequence: 1,
    });
    const responses = await Promise.all([
      doFetch("concurrency", "/event", event),
      doFetch("concurrency", "/event", event),
      doFetch("concurrency", "/event", event),
    ]);
    const outcomes = (await Promise.all(responses.map((response) => response.json()))) as Array<{
      replayed: boolean;
    }>;
    expect(outcomes.filter((outcome) => !outcome.replayed)).toHaveLength(1);
    expect((await admin("concurrency")).history).toHaveLength(1);
    expect((await admin("concurrency")).detectorReceipts).toHaveLength(1);
  });

  it("rejects a replay key whose decoded payload conflicts", async () => {
    const original = databaseEvent({
      id: "semantic-original",
      at: "2026-08-10T10:00:00.000Z",
      detectorId: "database-probe-a",
      detectorKind: "first_party_probe",
      sequence: 1,
    });
    expect((await doFetch("semantic-conflict", "/event", original)).status).toBe(200);
    const conflict = {
      ...original,
      eventId: "synthetic-semantic-conflict",
      signal: { ...original.signal, state: "pass", severity: "info" },
      sample: { ...original.sample, passed: 1, failed: 0 },
      evidence: {
        summaryCode: "database_probe_passed",
        digest: "evidence:aggregate:semantic-conflict",
      },
    } as const;
    const response = await doFetch("semantic-conflict", "/event", conflict);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      accepted: false,
      outcomeCode: "idempotency_conflict",
    });
    const snapshot = await admin("semantic-conflict");
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.detectorReceipts).toHaveLength(1);
  });

  it("keeps an outage proposal live across non-transition evidence", async () => {
    const name = "proposal-liveness";
    const [first, second, third] = [
      databaseEvent({
        id: "live-1",
        at: "2026-08-10T10:00:00.000Z",
        detectorId: "database-probe-a",
        detectorKind: "first_party_probe",
        sequence: 1,
      }),
      databaseEvent({
        id: "live-2",
        at: "2026-08-10T10:01:00.000Z",
        detectorId: "database-probe-b",
        detectorKind: "first_party_probe",
        sequence: 2,
      }),
      databaseEvent({
        id: "live-3",
        at: "2026-08-10T10:02:00.000Z",
        detectorId: "database-synthetic",
        detectorKind: "synthetic",
        sequence: 3,
      }),
    ];
    await doFetch(name, "/event", first);
    await doFetch(name, "/event", second);
    await doFetch(name, "/event", third);
    const beforeInterleaved = await admin(name);
    const proposal = beforeInterleaved.proposals.find((item) => item.to === "outage");
    expect(proposal).toBeDefined();
    if (!proposal) throw new Error("outage proposal missing");
    expect(proposal.from).toBe("unknown");
    expect(beforeInterleaved.history).toHaveLength(3);

    const interleaved = databaseEvent({
      id: "live-4",
      at: "2026-08-10T10:03:00.000Z",
      detectorId: "database-probe-a",
      detectorKind: "first_party_probe",
      sequence: 4,
    });
    expect(await (await doFetch(name, "/event", interleaved)).json()).toMatchObject({
      state: "outage",
      transition: null,
      incidentVersion: proposal.incidentVersion,
    });
    const afterInterleaved = await admin(name);
    expect(afterInterleaved.incidents[0]?.version).toBe(proposal.incidentVersion);
    expect(afterInterleaved.history).toHaveLength(4);
    expect(afterInterleaved.history.slice(0, 3)).toEqual(beforeInterleaved.history);
    expect(afterInterleaved.history[3]).toMatchObject({
      incidentVersion: proposal.incidentVersion,
      from: "outage",
      to: "outage",
      reasonCode: "outage_evidence_recorded",
      evidenceDigest: interleaved.evidence.digest,
    });

    expect(
      await (
        await doFetch(name, "/approval", approvalFor(proposal, "2026-08-10T10:04:00.000Z"))
      ).json(),
    ).toMatchObject({ ok: true, code: "published" });
    expect((await admin(name)).publicStatus.overall).toBe("outage");
  });

  it("rejects backdated incident evidence without moving incident time backwards", async () => {
    const name = "backdated-event";
    const first = databaseEvent({
      id: "ordered-1",
      at: "2026-08-10T10:00:00.000Z",
      detectorId: "database-probe-a",
      detectorKind: "first_party_probe",
      sequence: 1,
    });
    const second = databaseEvent({
      id: "ordered-2",
      at: "2026-08-10T10:02:00.000Z",
      detectorId: "database-probe-b",
      detectorKind: "first_party_probe",
      sequence: 2,
    });
    await doFetch(name, "/event", first);
    await doFetch(name, "/event", second);
    const before = (await admin(name)).incidents[0];
    const backdated = databaseEvent({
      id: "ordered-backdated",
      at: "2026-08-10T10:01:00.000Z",
      detectorId: "database-probe-c",
      detectorKind: "first_party_probe",
      sequence: 3,
    });
    const response = await doFetch(name, "/event", backdated);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      accepted: false,
      outcomeCode: "backdated_event",
    });
    const after = await admin(name);
    expect(after.incidents[0]?.updatedAt).toBe(before?.updatedAt);
    expect(after.incidents[0]?.version).toBe(before?.version);
    expect(after.detectorReceipts).toHaveLength(2);
  });

  it("does not go false-green when one of two published incidents resolves", async () => {
    const name = "multi-incident-overall";
    const databaseFailures = [
      targetEvent({
        id: "multi-db-1",
        at: "2026-08-10T14:00:00.000Z",
        target: "database",
        signalCode: "database_unavailable",
        summaryCode: "database_probe_failed",
        detectorId: "db-a",
        detectorKind: "first_party_probe",
        sequence: 1,
      }),
      targetEvent({
        id: "multi-db-2",
        at: "2026-08-10T14:01:00.000Z",
        target: "database",
        signalCode: "database_unavailable",
        summaryCode: "database_probe_failed",
        detectorId: "db-b",
        detectorKind: "first_party_probe",
        sequence: 2,
      }),
      targetEvent({
        id: "multi-db-3",
        at: "2026-08-10T14:02:00.000Z",
        target: "database",
        signalCode: "database_unavailable",
        summaryCode: "database_probe_failed",
        detectorId: "db-synthetic",
        detectorKind: "synthetic",
        sequence: 3,
      }),
    ];
    for (const event of databaseFailures) await doFetch(name, "/event", event);
    const databaseProposal = (await admin(name)).proposals.find((item) => item.to === "outage");
    expect(databaseProposal).toBeDefined();
    if (!databaseProposal) throw new Error("database proposal missing");
    await doFetch(name, "/approval", approvalFor(databaseProposal, "2026-08-10T14:03:00.000Z"));

    const webFailures = [
      targetEvent({
        id: "multi-web-1",
        at: "2026-08-10T15:00:00.000Z",
        target: "web",
        signalCode: "web_unavailable",
        summaryCode: "web_probe_failed",
        detectorId: "web-a",
        detectorKind: "first_party_probe",
        sequence: 1,
      }),
      targetEvent({
        id: "multi-web-2",
        at: "2026-08-10T15:01:00.000Z",
        target: "web",
        signalCode: "web_unavailable",
        summaryCode: "web_probe_failed",
        detectorId: "web-b",
        detectorKind: "first_party_probe",
        sequence: 2,
      }),
    ];
    for (const event of webFailures) await doFetch(name, "/event", event);
    const webProposal = (await admin(name)).proposals.find(
      (item) => item.incidentId !== databaseProposal.incidentId && item.to === "degraded",
    );
    expect(webProposal).toBeDefined();
    if (!webProposal) throw new Error("web proposal missing");
    await doFetch(name, "/approval", approvalFor(webProposal, "2026-08-10T15:02:00.000Z"));
    expect((await admin(name)).publicStatus.overall).toBe("outage");

    const webRecovery = [
      targetEvent({
        id: "multi-web-pass-1",
        at: "2026-08-10T15:02:00.000Z",
        target: "web",
        signalCode: "web_unavailable",
        summaryCode: "web_probe_passed",
        detectorId: "web-a",
        detectorKind: "first_party_probe",
        state: "pass",
        sequence: 3,
      }),
      targetEvent({
        id: "multi-web-pass-2",
        at: "2026-08-10T15:03:00.000Z",
        target: "web",
        signalCode: "web_unavailable",
        summaryCode: "web_probe_passed",
        detectorId: "web-b",
        detectorKind: "first_party_probe",
        state: "pass",
        sequence: 4,
      }),
      targetEvent({
        id: "multi-web-pass-3",
        at: "2026-08-10T15:07:00.000Z",
        target: "web",
        signalCode: "web_unavailable",
        summaryCode: "web_probe_passed",
        detectorId: "web-a",
        detectorKind: "first_party_probe",
        state: "pass",
        sequence: 5,
      }),
      targetEvent({
        id: "multi-web-independent",
        at: "2026-08-10T15:07:30.000Z",
        target: "web",
        signalCode: "web_unavailable",
        summaryCode: "web_probe_passed",
        detectorId: "web-provider",
        detectorKind: "provider_status",
        state: "pass",
        sequence: 1,
      }),
    ];
    for (const event of webRecovery) await doFetch(name, "/event", event);
    const resolutionProposal = (await admin(name)).proposals.find(
      (item) => item.incidentId === webProposal.incidentId && item.to === "operational",
    );
    expect(resolutionProposal).toBeDefined();
    if (!resolutionProposal) throw new Error("web resolution proposal missing");
    await doFetch(name, "/approval", approvalFor(resolutionProposal, "2026-08-10T15:08:00.000Z"));
    const final = await admin(name);
    expect(final.publicStatus.overall).toBe("outage");
    expect(final.publicStatus.incidents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: databaseProposal.incidentId, state: "outage" }),
        expect.objectContaining({ id: webProposal.incidentId, state: "resolved" }),
      ]),
    );
  });

  it("blocks automation side effects when the kill switch is off", async () => {
    const first = databaseEvent({
      id: "kill-a",
      at: "2026-08-10T11:00:00.000Z",
      detectorId: "probe-a",
      detectorKind: "first_party_probe",
      sequence: 1,
    });
    const second = databaseEvent({
      id: "kill-b",
      at: "2026-08-10T11:01:00.000Z",
      detectorId: "probe-b",
      detectorKind: "first_party_probe",
      sequence: 2,
    });
    await doFetch("automation-off", "/event", first, { automation: false });
    await doFetch("automation-off", "/event", second, { automation: false });
    const snapshot = await admin("automation-off");
    expect(snapshot.incidents[0]?.state).toBe("degraded");
    expect(snapshot.investigations).toHaveLength(0);
    expect(snapshot.proposals).toHaveLength(0);
    expect(snapshot.proposalDeliveries).toHaveLength(0);
  });

  it("records the exact launch suppression without opening an incident", async () => {
    const event = {
      ...databaseEvent({
        id: "shadow-suppression",
        at: "2026-08-20T12:00:00.000Z",
        detectorId: "ai-hero-skills-newsletter-path-entry-v2",
        detectorKind: "first_party_probe",
        sequence: 1,
      }),
      target: "learner_flow",
      signal: {
        state: "fail",
        severity: "degraded",
        code: "subscribe_to_shadow_newsletter_sequence_paused",
      },
      evidence: {
        summaryCode: "shadow_newsletter_sequence_paused",
        digest: "evidence:aggregate:shadow-suppression",
      },
    } as const;
    expect(await (await doFetch("suppression", "/event", event)).json()).toMatchObject({
      suppressed: true,
      outcomeCode: "suppressed_exact_rule",
    });
    const snapshot = await admin("suppression");
    expect(snapshot.incidents).toHaveLength(0);
    expect(snapshot.detectorReceipts[0]?.suppressionRuleId).toBe(
      "launch-shadow-newsletter-paused-v1",
    );
  });

  it("caps fake investigations while keeping excess incidents visible", async () => {
    const scenarios = [
      { target: "web", code: "web_unavailable", summary: "web_probe_failed" },
      { target: "auth", code: "auth_unavailable", summary: "auth_probe_failed" },
      { target: "checkout", code: "checkout_unavailable", summary: "checkout_probe_failed" },
      { target: "content", code: "content_unavailable", summary: "content_probe_failed" },
      { target: "database", code: "database_unavailable", summary: "database_probe_failed" },
      { target: "email", code: "email_unavailable", summary: "email_probe_failed" },
    ] as const;
    for (const [index, scenario] of scenarios.entries()) {
      for (const sample of [1, 2] as const) {
        const source = databaseEvent({
          id: `cap-${index}-${sample}`,
          at: `2026-08-10T13:${String(index * 2 + sample).padStart(2, "0")}:00.000Z`,
          detectorId: `cap-${index}-probe-${sample}`,
          detectorKind: "first_party_probe",
          sequence: sample,
        });
        await doFetch("investigation-cap", "/event", {
          ...source,
          target: scenario.target,
          signal: { ...source.signal, code: scenario.code },
          evidence: { ...source.evidence, summaryCode: scenario.summary },
        });
      }
    }
    const snapshot = await admin("investigation-cap");
    expect(snapshot.incidents).toHaveLength(6);
    expect(snapshot.investigations).toHaveLength(5);
    expect(snapshot.proposals).toHaveLength(6);
  });

  it("rejects publication when the public-write kill switch is off", async () => {
    const first = databaseEvent({
      id: "publish-a",
      at: "2026-08-10T12:00:00.000Z",
      detectorId: "probe-a",
      detectorKind: "first_party_probe",
      sequence: 1,
    });
    const second = databaseEvent({
      id: "publish-b",
      at: "2026-08-10T12:01:00.000Z",
      detectorId: "probe-b",
      detectorKind: "first_party_probe",
      sequence: 2,
    });
    await doFetch("public-off", "/event", first);
    await doFetch("public-off", "/event", second);
    const proposal = (await admin("public-off")).proposals[0] as PublicChangeProposal | undefined;
    expect(proposal).toBeDefined();
    if (!proposal) throw new Error("proposal missing");
    const response = await doFetch(
      "public-off",
      "/approval",
      {
        schemaVersion: "aih.status.fake-approval.v1",
        proposalId: proposal.proposalId,
        nonce: proposal.nonce,
        actor: "status-operator-1",
        incidentVersion: proposal.incidentVersion,
        publicProjectionDigest: proposal.publicProjectionDigest,
        observedAt: "2026-08-10T12:02:00.000Z",
        signatureValid: true,
      },
      { publicWrites: false },
    );
    expect(await response.json()).toMatchObject({ ok: false, code: "public_writes_disabled" });
    expect((await admin("public-off")).publicStatus.overall).toBe("unknown");
  });
});
