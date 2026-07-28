import {
  LEARNER_FLOW_STUCK_CAUSES,
  type LearnerFlowStuckCause,
} from "./learner-flow-classifier";
import {
  SignupGapSourceUnavailableError,
  type SignupGapPreview,
} from "./signup-gap-recovery";

export type LearnerFlowActionTier = "tier-1-auto" | "tier-2-ask";

export type LearnerFlowUnstickAction =
  | "replan-blocked-intent"
  | "retry-transient-failure"
  | "nudge-drip-progression"
  | "ask-joel";

export type LearnerFlowStuckItem = {
  contactId: string;
  intentId?: string;
  stage: string;
  stuckAgeHours?: number;
  cause: LearnerFlowStuckCause;
  unstickCommand?: string;
};

export type LearnerFlowTierPartition = {
  tier1: Array<
    LearnerFlowStuckItem & {
      action: Exclude<LearnerFlowUnstickAction, "ask-joel">;
    }
  >;
  tier2: Array<LearnerFlowStuckItem & { action: "ask-joel" }>;
  tier3: never[];
};

export type LearnerFlowSignupGapCheck =
  | { status: "available"; preview: SignupGapPreview }
  | {
      status: "source-unavailable";
      source: "kit";
      attempts: number;
      statusCode?: number;
      message: string;
    };

export async function checkLearnerFlowSignupGap(
  loadPreview: () => Promise<SignupGapPreview>,
): Promise<LearnerFlowSignupGapCheck> {
  try {
    return { status: "available", preview: await loadPreview() };
  } catch (error) {
    if (!(error instanceof SignupGapSourceUnavailableError)) throw error;
    return {
      status: "source-unavailable",
      source: error.source,
      attempts: error.attempts,
      statusCode: error.statusCode,
      message: error.message,
    };
  }
}

/**
 * The action envelope is deliberately total: every classifier cause has one
 * safe disposition. Tier 3 has no action representation, so a new/unknown
 * cause must fail closed into the ask-first tier until its policy is added.
 */
export function learnerFlowActionTier(
  cause: LearnerFlowStuckCause | string | undefined,
): LearnerFlowActionTier {
  switch (cause) {
    case "blocked-intent":
    case "retryable-failed-overdue":
    case "drip-starved":
      return "tier-1-auto";
    default:
      return "tier-2-ask";
  }
}

export function learnerFlowUnstickAction(
  cause: LearnerFlowStuckCause | string | undefined,
): LearnerFlowUnstickAction {
  switch (cause) {
    case "blocked-intent":
      return "replan-blocked-intent";
    case "retryable-failed-overdue":
      return "retry-transient-failure";
    case "drip-starved":
      return "nudge-drip-progression";
    default:
      return "ask-joel";
  }
}

export function partitionLearnerFlowUnstickItems(
  items: LearnerFlowStuckItem[],
): LearnerFlowTierPartition {
  const tier1: LearnerFlowTierPartition["tier1"] = [];
  const tier2: LearnerFlowTierPartition["tier2"] = [];

  for (const item of items) {
    const action = learnerFlowUnstickAction(item.cause);
    if (learnerFlowActionTier(item.cause) === "tier-1-auto") {
      tier1.push({
        ...item,
        action: action as LearnerFlowTierPartition["tier1"][number]["action"],
      });
    } else {
      tier2.push({ ...item, action: "ask-joel" });
    }
  }

  return { tier1, tier2, tier3: [] };
}

export function actionEnvelopeCoversEveryLearnerFlowCause() {
  return LEARNER_FLOW_STUCK_CAUSES.every((cause) => {
    const tier = learnerFlowActionTier(cause);
    const action = learnerFlowUnstickAction(cause);
    return (
      (tier === "tier-1-auto" && action !== "ask-joel") ||
      (tier === "tier-2-ask" && action === "ask-joel")
    );
  });
}

export const MAX_TIER_1_SIGNUP_GAP_REPLAY_COUNT = 25;
export const MAX_TIER_1_SIGNUP_GAP_REPLAY_AGE_MS = 48 * 60 * 60 * 1000;

export function isTier1SignupGapReplay(args: {
  candidateCount: number;
  candidateCreatedAt: string[];
  now: string;
}) {
  const nowMs = Date.parse(args.now);
  if (
    Number.isNaN(nowMs) ||
    args.candidateCount > MAX_TIER_1_SIGNUP_GAP_REPLAY_COUNT
  ) {
    return false;
  }
  return args.candidateCreatedAt.every((createdAt) => {
    const createdAtMs = Date.parse(createdAt);
    return (
      !Number.isNaN(createdAtMs) &&
      createdAtMs <= nowMs &&
      nowMs - createdAtMs < MAX_TIER_1_SIGNUP_GAP_REPLAY_AGE_MS
    );
  });
}
