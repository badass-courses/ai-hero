import type { PublicChangeProposal } from "../contracts/index";
import { stableDigest } from "../incident/policy";

export type ProposalDeliveryReceipt = {
  proposalId: string;
  receiptId: string;
  destination: "tracer_status_channel";
  createdAt: string;
};

export interface ProposalDeliveryAdapter {
  deliver(proposal: PublicChangeProposal): ProposalDeliveryReceipt;
}

export const fakeSlackAdapter: ProposalDeliveryAdapter = {
  deliver(proposal) {
    return {
      proposalId: proposal.proposalId,
      receiptId: `fake-delivery-${stableDigest(proposal.proposalId)}`,
      destination: "tracer_status_channel",
      createdAt: proposal.createdAt,
    };
  },
};
