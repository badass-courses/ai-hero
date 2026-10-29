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

type ParityTransition = Pick<
  DrovrParityTransitionReceipt,
  "fromState" | "toState" | "intentsEmitted"
>;

export function normalizeEmailCourseTransitionReceipts(args: {
  readonly definition: EmailCourseDefinition;
  readonly previous: EmailCoursePlanningState | null;
  readonly stimulus: EmailCourseStimulus;
  readonly decision: Extract<EmailCourseDecision, { type: "Accepted" }>;
}): readonly DrovrParityTransitionReceipt[] {
  return parityTransitions(args).map((transition) => ({
    tenantId: DROVR_PARITY_TENANT_ID,
    contactId: args.decision.next.contactId,
    journeyId: DROVR_SKILLS_COURSE_JOURNEY_ID,
    journeyVersion: 1,
    ...transition,
    cause: parityCause(args.stimulus),
    at: args.stimulus.occurredAt,
  }));
}

function parityTransitions(args: {
  readonly definition: EmailCourseDefinition;
  readonly previous: EmailCoursePlanningState | null;
  readonly stimulus: EmailCourseStimulus;
  readonly decision: Extract<EmailCourseDecision, { type: "Accepted" }>;
}): readonly ParityTransition[] {
  const intentsEmitted = emittedIntentCount(args.decision);
  const nextState: EmailCoursePlanningState = {
    run: args.decision.next,
    currentIntent: decisionCurrentIntent(args.decision),
  };

  if (args.stimulus.type === "ExplicitSignup") {
    return [
      {
        fromState: entryPendingState(args.definition),
        toState: parityState(args.definition, nextState),
        intentsEmitted,
      },
    ];
  }

  if (args.stimulus.type === "AnswerSelected") {
    const sentStep = findStep(args.definition, args.stimulus.sentStepId);
    if (sentStep) {
      return [
        {
          fromState: `email${sentStep.position}.waiting`,
          toState: parityState(args.definition, nextState),
          intentsEmitted,
        },
      ];
    }
  }

  if (
    args.stimulus.type === "DeliverySettled" &&
    args.stimulus.outcome.type === "Applied"
  ) {
    const currentStep = args.previous?.currentIntent
      ? findStep(args.definition, args.previous.currentIntent.stepId)
      : null;
    if (currentStep) {
      const settlementState =
        currentStep.defaultNextStepId === null
          ? "completed"
          : `email${currentStep.position}.waiting`;
      const transitions: ParityTransition[] = [
        {
          fromState: `email${currentStep.position}.pending`,
          toState: settlementState,
          intentsEmitted: 0,
        },
      ];
      const planned = args.decision.outboxChanges.find(
        (change) => change.type === "Plan",
      );
      if (planned?.type === "Plan") {
        const nextStep = findStep(args.definition, planned.intent.stepId);
        if (nextStep) {
          transitions.push({
            fromState: settlementState,
            toState: `email${nextStep.position}.pending`,
            intentsEmitted: 1,
          });
        }
      } else {
        const finalState = parityState(args.definition, nextState);
        if (finalState !== settlementState) {
          transitions.push({
            fromState: settlementState,
            toState: finalState,
            intentsEmitted: 0,
          });
        }
      }
      return transitions;
    }
  }

  return [
    {
      fromState: parityState(args.definition, args.previous),
      toState: parityState(args.definition, nextState),
      intentsEmitted,
    },
  ];
}

function emittedIntentCount(
  decision: Extract<EmailCourseDecision, { type: "Accepted" }>,
): number {
  return decision.outboxChanges.filter(
    (change) => change.type === "Plan" || change.type === "ReplaceRoute",
  ).length;
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
  if (!state) return entryPendingState(definition);
  if (state.run.phase === "stopped") {
    return state.run.reason.type === "CommunicationStopped" &&
      state.run.reason.reason === "Unsubscribed"
      ? "unsubscribed"
      : "blocked";
  }
  // AI Hero Held is temporary while drovr blocked is terminal. Keep this
  // deliberate mismatch visible in parity instead of pretending agreement.
  if (state.currentIntent?.status === "Held") return "blocked";
  const step = state.currentIntent
    ? findStep(definition, state.currentIntent.stepId)
    : null;
  if (!step) return state.run.phase;
  if (state.currentIntent?.status === "Settled") {
    switch (state.currentIntent.outcome.type) {
      case "Applied":
        return state.run.phase === "sequenceExhausted"
          ? "completed"
          : `email${step.position}.waiting`;
      case "CommunicationStopped":
        return state.currentIntent.outcome.reason === "Unsubscribed"
          ? "unsubscribed"
          : "blocked";
      case "PermanentRefusal":
        return "blocked";
    }
  }
  return `email${step.position}.pending`;
}

function entryPendingState(definition: EmailCourseDefinition): string {
  const step = findStep(definition, definition.entryStepId);
  return step ? `email${step.position}.pending` : "email0.pending";
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
