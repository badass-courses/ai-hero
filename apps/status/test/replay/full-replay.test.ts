import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AdminStatus, PublicChangeProposal } from "../../src/contracts/index";
import { openingEvents, recoveryEvents } from "../fixtures/database-outage-replay";

type ReplayResult = {
  schemaVersion: string;
  outcomes: Array<Record<string, unknown>>;
  admin: AdminStatus;
};

async function replay(actions: readonly unknown[]): Promise<ReplayResult> {
  const response = await SELF.fetch("https://status.test/__tracer/replay", {
    method: "POST",
    headers: {
      authorization: "Bearer fixture-tracer-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ schemaVersion: "aih.status.replay.v1", actions }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ReplayResult;
}

const eventActions = (events: readonly unknown[]) =>
  events.map((event) => ({ type: "event", event }));
const approvalAction = (
  proposal: PublicChangeProposal,
  overrides: Partial<{
    actor: string;
    incidentVersion: number;
    publicProjectionDigest: string;
    observedAt: string;
    signatureValid: boolean;
  }> = {},
) => ({
  type: "approval",
  approval: {
    schemaVersion: "aih.status.fake-approval.v1",
    proposalId: proposal.proposalId,
    nonce: proposal.nonce,
    actor: "status-operator-1",
    incidentVersion: proposal.incidentVersion,
    publicProjectionDigest: proposal.publicProjectionDigest,
    observedAt: "2026-08-10T10:04:00.000Z",
    signatureValid: true,
    ...overrides,
  },
});

describe("redacted database outage tracer", () => {
  it("replays the full incident without duplicate side effects", async () => {
    const [first, second, third] = openingEvents;
    const opened = await replay([
      { type: "event", event: first },
      { type: "event", event: first },
      { type: "event", event: second },
      { type: "event", event: third },
      { type: "event", event: third },
      { type: "event", event: third },
    ]);

    expect(opened.outcomes[0]).toMatchObject({ state: "investigating", replayed: false });
    expect(opened.outcomes[1]).toMatchObject({ state: "investigating", replayed: true });
    expect(opened.outcomes[2]).toMatchObject({ state: "degraded", investigationCreated: true });
    expect(opened.outcomes[3]).toMatchObject({ state: "outage" });
    expect(opened.admin.incidents).toHaveLength(1);
    expect(opened.admin.incidents[0]?.state).toBe("outage");
    expect(opened.admin.history).toHaveLength(3);
    expect(opened.admin.investigations).toHaveLength(1);
    expect(opened.admin.proposals).toHaveLength(2);
    expect(opened.admin.proposalDeliveries).toHaveLength(2);
    expect(new Set(opened.admin.proposals.map((proposal) => proposal.incidentVersion)).size).toBe(
      2,
    );
    expect(opened.admin.publicStatus.overall).toBe("unknown");

    const outageProposal = opened.admin.proposals.find((proposal) => proposal.to === "outage");
    expect(outageProposal).toBeDefined();
    if (!outageProposal) throw new Error("outage proposal missing");

    const invalid = await replay([
      approvalAction(outageProposal, { signatureValid: false }),
      approvalAction(outageProposal, { observedAt: "2026-08-10T10:30:00.000Z" }),
      approvalAction(outageProposal, { actor: "not-an-operator" }),
      approvalAction(outageProposal, { incidentVersion: outageProposal.incidentVersion - 1 }),
      approvalAction(outageProposal, { publicProjectionDigest: "digest:mismatch" }),
    ]);
    expect(invalid.outcomes.map((outcome) => outcome.code)).toEqual([
      "invalid_signature",
      "proposal_expired",
      "actor_not_allowed",
      "stale_incident_version",
      "digest_mismatch",
    ]);
    expect(invalid.admin.publicStatus.overall).toBe("unknown");

    const approved = await replay([approvalAction(outageProposal)]);
    expect(approved.outcomes[0]).toMatchObject({ ok: true, code: "published" });
    expect(approved.admin.publicStatus.overall).toBe("outage");

    const replayedApproval = await replay([approvalAction(outageProposal)]);
    expect(replayedApproval.outcomes[0]).toMatchObject({ ok: false, code: "nonce_replayed" });
    expect(replayedApproval.admin.publicStatus.overall).toBe("outage");

    const recovered = await replay(eventActions(recoveryEvents));
    expect(recovered.outcomes[3]).toMatchObject({ state: "recovering" });
    expect(recovered.outcomes[5]).toMatchObject({ state: "recovering" });
    expect(recovered.outcomes[6]).toMatchObject({ state: "resolved" });
    expect(recovered.admin.publicStatus.overall).toBe("outage");
    expect(recovered.admin.incidents[0]?.state).toBe("resolved");

    const resolutionProposal = recovered.admin.proposals.find(
      (proposal) => proposal.to === "operational",
    );
    expect(resolutionProposal).toBeDefined();
    if (!resolutionProposal) throw new Error("resolution proposal missing");
    const resolved = await replay([
      approvalAction(resolutionProposal, { observedAt: "2026-08-10T10:11:00.000Z" }),
    ]);
    expect(resolved.outcomes[0]).toMatchObject({ ok: true, code: "published" });
    expect(resolved.admin.publicStatus.overall).toBe("unknown");
    expect(resolved.admin.publicStatus.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "database", state: "operational" }),
        expect.objectContaining({ key: "web", state: "unknown" }),
      ]),
    );
    expect(resolved.admin.publicStatus.incidents[0]?.state).toBe("resolved");

    const repeated = await replay([
      ...eventActions(openingEvents),
      ...eventActions(recoveryEvents),
      approvalAction(outageProposal),
      approvalAction(resolutionProposal, { observedAt: "2026-08-10T10:11:00.000Z" }),
    ]);
    expect(repeated.admin.incidents).toHaveLength(1);
    expect(repeated.admin.history).toHaveLength(10);
    expect(repeated.admin.investigations).toHaveLength(1);
    expect(repeated.admin.proposals).toHaveLength(3);
    expect(repeated.admin.proposalDeliveries).toHaveLength(3);
    expect(repeated.admin.publicStatus.overall).toBe("unknown");

    const publicResponse = await SELF.fetch("https://status.test/status.json");
    const publicText = await publicResponse.text();
    for (const forbidden of [
      "sessionId",
      "evidenceDigest",
      "detectorId",
      "rawLog",
      "customerEmail",
    ]) {
      expect(publicText).not.toContain(forbidden);
    }
    expect(publicText).not.toContain("aggregate_database_failure_supported");
  });
});
