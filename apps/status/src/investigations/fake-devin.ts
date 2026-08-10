import { decodeDevinResult, type DevinInvestigationResult } from "../contracts/index";
import { TRACER_POLICY, stableDigest } from "../incident/policy";
import { fakeAxiomAdapter } from "./fake-evidence";

export interface InvestigationAdapter {
  investigate(input: {
    incidentId: string;
    startedAt: string;
    evidenceDigest: string;
  }): DevinInvestigationResult;
}

export const fakeDevinAdapter: InvestigationAdapter = {
  investigate({ incidentId, startedAt, evidenceDigest }) {
    const queryReceipt = fakeAxiomAdapter.query({
      incidentId,
      evidenceDigest,
      summaryCode: "aggregate_database_failure_supported",
    });
    const result = {
      schemaVersion: "aih.status.devin-result.v1",
      incidentId,
      sessionId: `fake-${stableDigest(`${incidentId}:${startedAt}`)}`,
      startedAt,
      completedAt: startedAt,
      outcome: "supported",
      confidence: "medium",
      summaryCode: "aggregate_database_failure_supported",
      hypotheses: [
        {
          statement: "aggregate_database_path_failure",
          status: "supported",
          evidenceRefs: [evidenceDigest],
        },
      ],
      observedFacts: [{ code: "aggregate_failure_threshold_met", evidenceRefs: [evidenceDigest] }],
      unknowns: ["root_cause_not_queried_in_tracer"],
      recommendedOperatorActions: ["review_private_incident_evidence"],
      queries: [queryReceipt],
      limits: {
        acuMax: TRACER_POLICY.fakeInvestigationAcuMax,
        elapsedSeconds: 0,
        timedOut: false,
      },
      privacy: {
        aggregateOnly: true,
        rawLogsIncluded: false,
        customerIdentifiersIncluded: false,
      },
    } as const;
    return validateFakeDevinResult(result);
  },
};

export function validateFakeDevinResult(input: unknown): DevinInvestigationResult {
  const result = decodeDevinResult(input);
  if (result.limits.acuMax > TRACER_POLICY.fakeInvestigationAcuMax) {
    throw new Error("fake investigation ACU cap exceeded");
  }
  if (result.limits.elapsedSeconds > 900) {
    throw new Error("fake investigation time cap exceeded");
  }
  return result;
}
