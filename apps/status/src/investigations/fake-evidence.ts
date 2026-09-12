import { stableDigest } from "../incident/policy";

export type QueryReceipt = {
  system: "axiom";
  receiptId: string;
};

export interface QueryOnlyEvidenceAdapter {
  query(input: { incidentId: string; evidenceDigest: string; summaryCode: string }): QueryReceipt;
}

export const fakeAxiomAdapter: QueryOnlyEvidenceAdapter = {
  query({ incidentId, evidenceDigest, summaryCode }) {
    return {
      system: "axiom",
      receiptId: `fake-query-${stableDigest(`${incidentId}:${evidenceDigest}:${summaryCode}`)}`,
    };
  },
};
