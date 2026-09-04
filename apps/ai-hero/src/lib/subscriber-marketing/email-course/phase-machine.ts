import {
  initialTransition,
  setup,
  transition,
  type SnapshotFrom,
} from "xstate";

import type { EmailCoursePhase } from "./domain";

export type EmailCoursePhaseEvent =
  | { readonly type: "SIGNUP_PLANNED" }
  | { readonly type: "DELIVERY_SETTLED_WITH_NEXT" }
  | { readonly type: "NEXT_EMAIL_DUE" }
  | { readonly type: "ANSWER_ACCELERATED" }
  | { readonly type: "DELIVERY_RETRY_SCHEDULED" }
  | { readonly type: "RETRY_DUE" }
  | { readonly type: "SEQUENCE_EXHAUSTED" }
  | { readonly type: "STOP" };

const phaseState = {
  "active.awaitingDelivery": "awaitingDelivery",
  "active.awaitingNextDue": "awaitingNextDue",
  "active.retryWait": "retryWait",
  sequenceExhausted: "sequenceExhausted",
  stopped: "stopped",
} as const satisfies Record<EmailCoursePhase, string>;

const statePhase = {
  awaitingDelivery: "active.awaitingDelivery",
  awaitingNextDue: "active.awaitingNextDue",
  retryWait: "active.retryWait",
  sequenceExhausted: "sequenceExhausted",
  stopped: "stopped",
} as const satisfies Record<string, EmailCoursePhase>;

export const emailCoursePhaseMachine = setup({
  types: {
    // SAFETY: XState reads this value only as compile-time event metadata.
    events: {} as EmailCoursePhaseEvent,
  },
}).createMachine({
  id: "email-course",
  initial: "notStarted",
  states: {
    notStarted: {
      on: { SIGNUP_PLANNED: "awaitingDelivery" },
    },
    awaitingDelivery: {
      on: {
        DELIVERY_SETTLED_WITH_NEXT: "awaitingNextDue",
        DELIVERY_RETRY_SCHEDULED: "retryWait",
        SEQUENCE_EXHAUSTED: "sequenceExhausted",
        STOP: "stopped",
      },
    },
    awaitingNextDue: {
      on: {
        NEXT_EMAIL_DUE: "awaitingDelivery",
        ANSWER_ACCELERATED: "awaitingDelivery",
        STOP: "stopped",
      },
    },
    retryWait: {
      on: {
        RETRY_DUE: "awaitingDelivery",
        STOP: "stopped",
      },
    },
    sequenceExhausted: { type: "final" },
    stopped: { type: "final" },
  },
});

export type EmailCoursePhaseTransitionResult =
  | { readonly ok: true; readonly phase: EmailCoursePhase }
  | {
      readonly ok: false;
      readonly from: EmailCoursePhase | "not_started";
      readonly event: EmailCoursePhaseEvent["type"];
    };

export function transitionEmailCoursePhase(args: {
  from: EmailCoursePhase | "not_started";
  event: EmailCoursePhaseEvent;
}): EmailCoursePhaseTransitionResult {
  const current =
    args.from === "not_started"
      ? initialTransition(emailCoursePhaseMachine)[0]
      : emailCoursePhaseMachine.resolveState({
          value: phaseState[args.from],
          context: {},
        });
  const [next] = transition(emailCoursePhaseMachine, current, args.event);
  if (next.value === current.value) {
    return { ok: false, from: args.from, event: args.event.type };
  }
  const phase = phaseFromSnapshot(next);
  return phase
    ? { ok: true, phase }
    : { ok: false, from: args.from, event: args.event.type };
}

function phaseFromSnapshot(
  snapshot: SnapshotFrom<typeof emailCoursePhaseMachine>,
): EmailCoursePhase | null {
  if (snapshot.matches("awaitingDelivery")) return statePhase.awaitingDelivery;
  if (snapshot.matches("awaitingNextDue")) return statePhase.awaitingNextDue;
  if (snapshot.matches("retryWait")) return statePhase.retryWait;
  if (snapshot.matches("sequenceExhausted")) {
    return statePhase.sequenceExhausted;
  }
  if (snapshot.matches("stopped")) return statePhase.stopped;
  return null;
}
