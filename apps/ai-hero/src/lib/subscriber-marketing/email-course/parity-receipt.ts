import type { Effect } from "effect";

import type { EmailCourseDefinition } from "./definition";
import type {
  CourseEmailIntent,
  EmailCourseDecision,
  EmailCoursePlanningState,
  EmailCourseStimulus,
} from "./domain";

export const DROVR_PARITY_TENANT_ID = "org-aihero-shadow" as const;
export const DROVR_SKILLS_COURSE_JOURNEY_ID =
  "value-path-skills-course" as const;

export type DrovrParityTransitionReceipt = {
  readonly tenantId: typeof DROVR_PARITY_TENANT_ID;
  readonly contactId: string;
  readonly journeyId: typeof DROVR_SKILLS_COURSE_JOURNEY_ID;
  readonly journeyVersion: 1;
  readonly fromState: string;
  readonly toState: string;
  readonly cause: string;
  readonly intentsEmitted: number;
  readonly at: string;
};

export interface DrovrParityReceiptSink {
  readonly push: (
    receipt: DrovrParityTransitionReceipt,
  ) => Effect.Effect<void, never>;
}

export function normalizeEmailCourseTransitionReceipt(args: {
  readonly definition: EmailCourseDefinition;
  readonly previous: EmailCoursePlanningState | null;
  readonly stimulus: EmailCourseStimulus;
  readonly decision: Extract<EmailCourseDecision, { type: "Accepted" }>;
}): DrovrParityTransitionReceipt {
  return {
    tenantId: DROVR_PARITY_TENANT_ID,
    contactId: args.decision.next.contactId,
    journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
    journeyVersion: 1,
    fromState: parityState(args.definition, args.previous),
    toState: parityState(args.definition, {
      run: args.decision.next,
      currentIntent: decisionCurrentIntent(args.decision),
    }),
    cause: parityCause(args.stimulus),
    intentsEmitted: args.decision.outboxChanges.filter(
      (change) => change.type === "Plan" || change.type === "ReplaceRoute",
    ).length,
    at: args.stimulus.occurredAt,
  };
}

function decisionCurrentIntent(
  decision: Extract<EmailCourseDecision, { type: "Accepted" }>,
): CourseEmailIntent | null {
  for (const change of decision.outboxChanges.toReversed()) {
    switch (change.type) {
      case "Plan":
        return change.intent;
      case "ReplaceRoute":
        return change.replacement;
      case "Accelerate":
      case "ScheduleRetry":
      case "Hold":
      case "Settle":
        return change.intent;
    }
  }
  return null;
}

function parityState(
  definition: EmailCourseDefinition,
  state: EmailCoursePlanningState | null,
): string {
  if (!state) return "entry";
  if (state.run.phase === "stopped") {
    return state.run.reason.type === "CommunicationStopped" &&
      state.run.reason.reason === "Unsubscribed"
      ? "unsubscribed"
      : "blocked";
  }
  if (
    state.run.phase === "sequenceExhausted" &&
    state.currentIntent?.status === "Settled" &&
    state.currentIntent.outcome.type === "Applied"
  ) {
    return "completed";
  }
  if (state.currentIntent?.status === "Held") return "blocked";
  const step = state.currentIntent
    ? findStep(definition, state.currentIntent.stepId)
    : null;
  return step ? `email${step.position}.pending` : state.run.phase;
}

function parityCause(stimulus: EmailCourseStimulus): string {
  switch (stimulus.type) {
    case "ExplicitSignup":
      return "journey.started";
    case "AnswerSelected":
      return "value-path.answer-selected";
    case "RepairRequested":
      return "repair.requested";
    case "DeliverySettled":
      switch (stimulus.outcome.type) {
        case "Applied":
          return "email.completed";
        case "TransientFailure":
          return "provider.retry";
        case "PermanentRefusal":
          return "provider.refused";
        case "Ambiguous":
          return "provider.ambiguous";
        case "CommunicationStopped":
          return stimulus.outcome.reason === "Unsubscribed"
            ? "contact.unsubscribed"
            : "communication.stopped";
      }
  }
}

function findStep(
  definition: EmailCourseDefinition,
  stepId: CourseEmailIntent["stepId"],
) {
  for (const path of definition.paths) {
    const step = path.steps.find((candidate) => candidate.stepId === stepId);
    if (step) return step;
  }
  return null;
}
