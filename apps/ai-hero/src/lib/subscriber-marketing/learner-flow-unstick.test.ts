import { describe, expect, it } from "vitest";

import { LEARNER_FLOW_STUCK_CAUSES } from "./learner-flow-classifier";
import {
  actionEnvelopeCoversEveryLearnerFlowCause,
  checkLearnerFlowSignupGap,
  isTier1SignupGapReplay,
  learnerFlowActionTier,
  learnerFlowUnstickAction,
  partitionLearnerFlowUnstickItems,
} from "./learner-flow-unstick";
import { SignupGapSourceUnavailableError } from "./signup-gap-recovery";

describe("learner flow unstick action envelope", () => {
  it("maps every classifier cause to exactly one executable tier", () => {
    expect(actionEnvelopeCoversEveryLearnerFlowCause()).toBe(true);
    for (const cause of LEARNER_FLOW_STUCK_CAUSES) {
      const tier = learnerFlowActionTier(cause);
      const action = learnerFlowUnstickAction(cause);
      expect(["tier-1-auto", "tier-2-ask"]).toContain(tier);
      expect(action === "ask-joel").toBe(tier === "tier-2-ask");
    }
  });

  it("fails unknown causes closed into the ask-first tier", () => {
    expect(learnerFlowActionTier("new-cause")).toBe("tier-2-ask");
    expect(learnerFlowUnstickAction("new-cause")).toBe("ask-joel");
  });

  it("keeps tier 3 structurally empty and partitions tier-1 actions", () => {
    const partition = partitionLearnerFlowUnstickItems([
      {
        contactId: "blocked",
        intentId: "blocked-intent-1",
        stage: "email-1",
        cause: "blocked-intent",
      },
      {
        contactId: "retry",
        stage: "email-2",
        cause: "retryable-failed-overdue",
      },
      { contactId: "drip", stage: "email-3", cause: "drip-starved" },
      { contactId: "ask", stage: "email-4", cause: "human-review-parked" },
    ]);
    expect(partition.tier1.map((item) => item.action)).toEqual([
      "replan-blocked-intent",
      "retry-transient-failure",
      "nudge-drip-progression",
    ]);
    expect(partition.tier1[0]).toMatchObject({ intentId: "blocked-intent-1" });
    expect(partition.tier2.map((item) => item.contactId)).toEqual(["ask"]);
    expect(partition.tier3).toEqual([]);
  });

  it("keeps DB cause partitioning available when the Kit gap source stays down", async () => {
    const partition = partitionLearnerFlowUnstickItems([
      { contactId: "blocked", stage: "email-1", cause: "blocked-intent" },
    ]);
    const gapCheck = await checkLearnerFlowSignupGap(async () => {
      throw new SignupGapSourceUnavailableError({
        attempts: 3,
        statusCode: 500,
      });
    });

    expect(partition.tier1).toHaveLength(1);
    expect(gapCheck).toMatchObject({
      status: "source-unavailable",
      source: "kit",
      attempts: 3,
      statusCode: 500,
    });
  });

  it("permits signup-gap replay only for fresh batches of 25 or fewer", () => {
    const now = "2026-07-15T12:00:00.000Z";
    expect(
      isTier1SignupGapReplay({
        candidateCount: 25,
        candidateCreatedAt: ["2026-07-14T12:00:00.001Z"],
        now,
      }),
    ).toBe(true);
    expect(
      isTier1SignupGapReplay({
        candidateCount: 26,
        candidateCreatedAt: ["2026-07-15T11:00:00.000Z"],
        now,
      }),
    ).toBe(false);
    expect(
      isTier1SignupGapReplay({
        candidateCount: 1,
        candidateCreatedAt: ["2026-07-13T12:00:00.000Z"],
        now,
      }),
    ).toBe(false);
  });
});
