import { createHash } from "node:crypto";

import type {
  EmailCourseDefinition,
  EmailCourseStepDefinition,
} from "./definition";
import {
  EMAIL_COURSE_ACTIVE_SLOT,
  EMAIL_COURSE_SCHEMA_VERSION,
  type ActiveCourseEmailIntent,
  type AutomationControl,
  type CommunicationDecision,
  type CourseEmailIntent,
  type CourseStopReason,
  type DeliveryOutcome,
  type EmailCourseDecision,
  type EmailCoursePlanningState,
  type EmailCourseRun,
  type EmailCourseStimulus,
  type HeldCourseEmailIntent,
  type PendingCourseEmailIntent,
  type RetryWaitingCourseEmailIntent,
  type SettledCourseEmailIntent,
} from "./domain";
import {
  courseIntentKey,
  deriveCourseRunId,
  parseEventId,
  parseIntentId,
  parseIsoInstant,
  type CoursePathId,
  type CourseStepId,
  type IsoInstant,
} from "./primitives";
import type { CourseScheduleDecision } from "./ports";

const RETRY_DELAY_MS = 15 * 60 * 1000;

export type DecideEmailCourseInput = {
  readonly definition: EmailCourseDefinition;
  readonly state: EmailCoursePlanningState | null;
  readonly stimulus: EmailCourseStimulus;
  readonly automationControl: AutomationControl;
  readonly communication: CommunicationDecision;
  readonly schedule: CourseScheduleDecision | null;
};

export type DecideEmailCourseResult =
  | { readonly ok: true; readonly decision: EmailCourseDecision }
  | { readonly ok: false; readonly reason: string };

export function decideEmailCourse(
  input: DecideEmailCourseInput,
): DecideEmailCourseResult {
  if (input.stimulus.type === "ExplicitSignup") {
    if (input.state) return failure("Course run already exists");
    if (input.stimulus.courseId !== input.definition.courseId) {
      return failure("Signup course does not match the definition");
    }
    return startCourse(input);
  }

  const state = input.state;
  if (!state) return failure("Course run does not exist");
  if (input.stimulus.runId !== state.run.runId) {
    return failure("Stimulus run does not match the loaded course run");
  }
  if (input.stimulus.type === "RepairRequested") {
    return failure("Repair stimuli are not normal course planning");
  }
  if (
    input.stimulus.type === "DeliverySettled" &&
    input.stimulus.outcome.type === "Applied"
  ) {
    if (input.automationControl.type === "Stopped") {
      return settleAppliedThenStop(state, input.stimulus, {
        type: "AutomationStopped",
        reason: input.automationControl.reason,
      });
    }
    if (input.communication.type === "Stop") {
      return settleAppliedThenStop(state, input.stimulus, {
        type: "CommunicationStopped",
        reason: input.communication.reason,
      });
    }
  }
  if (isFinalWithoutSettleableIntent(state, input.stimulus)) {
    return { ok: true, decision: { type: "Ignored", reason: "LateAnswer" } };
  }
  if (input.automationControl.type === "Stopped") {
    return stopForAutomation(input, state);
  }
  if (input.communication.type === "Stop") {
    return stopForCommunication(input, state, input.communication.reason);
  }
  if (input.stimulus.type === "AnswerSelected") {
    return answerSelected(input, state);
  }
  return deliverySettled(input, state);
}

function startCourse(input: DecideEmailCourseInput): DecideEmailCourseResult {
  const stimulus = input.stimulus;
  if (stimulus.type !== "ExplicitSignup") return failure("Expected signup");
  const runId = deriveCourseRunId({
    courseId: stimulus.courseId,
    entryEventId: stimulus.entryEventId,
  });
  const base = {
    schemaVersion: EMAIL_COURSE_SCHEMA_VERSION,
    runId,
    contactId: stimulus.contactId,
    courseId: stimulus.courseId,
    definitionVersion: input.definition.version,
    entryEventId: stimulus.entryEventId,
    scheduleEvidence: stimulus.scheduleEvidence,
    actorVersion: 1,
    startedAt: stimulus.occurredAt,
  } as const;
  const started = {
    type: "CourseRunStarted" as const,
    runId,
    occurredAt: stimulus.occurredAt,
  };

  if (input.automationControl.type === "Stopped") {
    return accepted({
      next: {
        ...base,
        phase: "stopped",
        reason: {
          type: "AutomationStopped",
          reason: input.automationControl.reason,
        },
        stoppedAt: stimulus.occurredAt,
      },
      events: [
        started,
        stoppedEvent(
          { type: "AutomationStopped", reason: input.automationControl.reason },
          stimulus.occurredAt,
        ),
      ],
      outboxChanges: [],
    });
  }
  if (input.communication.type === "Stop") {
    const reason = {
      type: "CommunicationStopped" as const,
      reason: input.communication.reason,
    };
    return accepted({
      next: {
        ...base,
        phase: "stopped",
        reason,
        stoppedAt: stimulus.occurredAt,
      },
      events: [started, stoppedEvent(reason, stimulus.occurredAt)],
      outboxChanges: [],
    });
  }

  const step = findStep(input.definition, input.definition.entryStepId);
  if (!step) return failure("Course entry step is missing");
  const intent = pendingIntent({
    runId,
    contactId: stimulus.contactId,
    step,
    availableAt: stimulus.occurredAt,
  });
  return accepted({
    next: {
      ...base,
      phase: "active.awaitingDelivery",
      activeIntentId: intent.id,
    },
    events: [
      started,
      {
        type: "NextEmailPlanned",
        intentId: intent.id,
        stepId: intent.stepId,
        availableAt: intent.availableAt,
        occurredAt: stimulus.occurredAt,
      },
    ],
    outboxChanges: [{ type: "Plan", intent }],
  });
}

function answerSelected(
  input: DecideEmailCourseInput,
  state: EmailCoursePlanningState,
): DecideEmailCourseResult {
  const stimulus = input.stimulus;
  if (stimulus.type !== "AnswerSelected") {
    return failure("Expected answer selection");
  }
  if (
    state.run.phase === "sequenceExhausted" ||
    state.run.phase === "stopped" ||
    !state.currentIntent ||
    state.currentIntent.status !== "Pending"
  ) {
    return { ok: true, decision: { type: "Ignored", reason: "LateAnswer" } };
  }
  const sentStep = findStep(input.definition, stimulus.sentStepId);
  const currentStep = findStep(input.definition, state.currentIntent.stepId);
  const selectedStep = stimulus.selectedNextStepId
    ? findStep(input.definition, stimulus.selectedNextStepId)
    : null;
  if (
    !sentStep ||
    !currentStep ||
    !selectedStep ||
    selectedStep.pathId !== stimulus.selectedPathId ||
    currentStep.position !== sentStep.position + 1 ||
    selectedStep.position !== sentStep.position + 1
  ) {
    return { ok: true, decision: { type: "Ignored", reason: "LateAnswer" } };
  }

  const replacement = pendingIntent({
    runId: state.run.runId,
    contactId: state.run.contactId,
    step: selectedStep,
    availableAt: stimulus.occurredAt,
  });
  const routeChanged = replacement.stepId !== state.currentIntent.stepId;
  const next = {
    ...state.run,
    actorVersion: state.run.actorVersion + 1,
    phase: "active.awaitingDelivery" as const,
    activeIntentId: replacement.id,
  };
  const events = [
    {
      type: "AnswerObserved" as const,
      answerEventId: stimulus.answerEventId,
      selectedPathId: stimulus.selectedPathId,
      occurredAt: stimulus.occurredAt,
    },
    ...(routeChanged
      ? [
          {
            type: "NextEmailRouteChanged" as const,
            intentId: replacement.id,
            fromStepId: state.currentIntent.stepId,
            toStepId: replacement.stepId,
            answerEventId: stimulus.answerEventId,
            occurredAt: stimulus.occurredAt,
          },
        ]
      : []),
    {
      type: "NextEmailAccelerated" as const,
      intentId: replacement.id,
      answerEventId: stimulus.answerEventId,
      availableAt: stimulus.occurredAt,
      occurredAt: stimulus.occurredAt,
    },
  ];
  return accepted({
    next,
    events,
    outboxChanges: routeChanged
      ? [
          {
            type: "ReplaceRoute",
            expectedIntentId: state.currentIntent.id,
            replacement,
          },
        ]
      : [{ type: "Accelerate", intent: replacement }],
  });
}

function deliverySettled(
  input: DecideEmailCourseInput,
  state: EmailCoursePlanningState,
): DecideEmailCourseResult {
  const stimulus = input.stimulus;
  if (stimulus.type !== "DeliverySettled") {
    return failure("Expected delivery settlement");
  }
  const current = state.currentIntent;
  if (
    !current ||
    current.id !== stimulus.intentId ||
    current.status === "Settled"
  ) {
    return failure("Delivery does not match the active intent");
  }

  switch (stimulus.outcome.type) {
    case "Applied":
      return applyDelivery(input, state, current, stimulus.outcome);
    case "TransientFailure":
      return retryDelivery(state, current, stimulus);
    case "Ambiguous":
      return holdAmbiguous(state, current, stimulus);
    case "PermanentRefusal":
      return stopForPermanentRefusal(state, current, stimulus);
    case "CommunicationStopped":
      return stopForCommunication(
        input,
        state,
        stimulus.outcome.reason,
        stimulus.outcome,
      );
  }
}

function applyDelivery(
  input: DecideEmailCourseInput,
  state: EmailCoursePlanningState,
  current: ActiveCourseEmailIntent,
  outcome: Extract<DeliveryOutcome, { type: "Applied" }>,
): DecideEmailCourseResult {
  const settled = settledIntent(current, outcome, outcome.appliedAt);
  const deliveryEvent = {
    type: "DeliveryRecorded" as const,
    intentId: current.id,
    outcome,
    occurredAt: input.stimulus.occurredAt,
  };

  if (state.run.phase === "sequenceExhausted") {
    return accepted({
      next: { ...state.run, actorVersion: state.run.actorVersion + 1 },
      events: [deliveryEvent],
      outboxChanges: [{ type: "Settle", intent: settled }],
    });
  }
  if (state.run.phase === "stopped") {
    return failure("Stopped course cannot apply delivery");
  }

  const currentStep = findStep(input.definition, current.stepId);
  if (!currentStep) return failure("Current course step is missing");
  const nextStep = currentStep.defaultNextStepId
    ? findStep(input.definition, currentStep.defaultNextStepId)
    : null;
  if (!nextStep) {
    const factId = exhaustionFactId(state.run.runId, current.pathId);
    return accepted({
      next: {
        ...state.run,
        actorVersion: state.run.actorVersion + 1,
        phase: "sequenceExhausted",
        exhaustionFactId: factId,
        exhaustedAt: input.stimulus.occurredAt,
        terminalIntentId: current.id,
        terminalStepId: current.stepId,
      },
      events: [
        deliveryEvent,
        {
          type: "CourseSequenceExhausted",
          factId,
          terminalIntentId: current.id,
          terminalStepId: current.stepId,
          occurredAt: input.stimulus.occurredAt,
        },
      ],
      outboxChanges: [{ type: "Settle", intent: settled }],
    });
  }
  if (!input.schedule) return failure("Next-email schedule is missing");
  const nextIntent = pendingIntent({
    runId: state.run.runId,
    contactId: state.run.contactId,
    step: nextStep,
    availableAt: input.schedule.availableAt,
  });
  const terminal = nextStep.defaultNextStepId === null;
  const factId = terminal
    ? exhaustionFactId(state.run.runId, nextStep.pathId)
    : null;
  const nextRun: EmailCourseRun = terminal
    ? {
        ...state.run,
        actorVersion: state.run.actorVersion + 1,
        phase: "sequenceExhausted",
        exhaustionFactId: factId!,
        exhaustedAt: input.stimulus.occurredAt,
        terminalIntentId: nextIntent.id,
        terminalStepId: nextIntent.stepId,
      }
    : {
        ...state.run,
        actorVersion: state.run.actorVersion + 1,
        phase: "active.awaitingNextDue",
        activeIntentId: nextIntent.id,
      };
  return accepted({
    next: nextRun,
    events: [
      deliveryEvent,
      {
        type: "NextEmailPlanned",
        intentId: nextIntent.id,
        stepId: nextIntent.stepId,
        availableAt: nextIntent.availableAt,
        occurredAt: input.stimulus.occurredAt,
      },
      ...(terminal
        ? [
            {
              type: "CourseSequenceExhausted" as const,
              factId: factId!,
              terminalIntentId: nextIntent.id,
              terminalStepId: nextIntent.stepId,
              occurredAt: input.stimulus.occurredAt,
            },
          ]
        : []),
    ],
    outboxChanges: [
      { type: "Settle", intent: settled },
      { type: "Plan", intent: nextIntent },
    ],
  });
}

function settleAppliedThenStop(
  state: EmailCoursePlanningState,
  stimulus: Extract<EmailCourseStimulus, { type: "DeliverySettled" }>,
  reason: CourseStopReason,
): DecideEmailCourseResult {
  if (stimulus.outcome.type !== "Applied") {
    return failure("Expected applied delivery before hard stop");
  }
  const current = activeIntent(state.currentIntent);
  if (!current || current.id !== stimulus.intentId) {
    return failure("Applied delivery does not match the active intent");
  }
  const terminal = state.run.phase === "sequenceExhausted";
  return accepted({
    next: terminal
      ? { ...state.run, actorVersion: state.run.actorVersion + 1 }
      : stoppedRun(state.run, reason, stimulus.occurredAt),
    events: [
      {
        type: "DeliveryRecorded",
        intentId: current.id,
        outcome: stimulus.outcome,
        occurredAt: stimulus.occurredAt,
      },
      ...(terminal ? [] : [stoppedEvent(reason, stimulus.occurredAt)]),
    ],
    outboxChanges: [
      {
        type: "Settle",
        intent: settledIntent(
          current,
          stimulus.outcome,
          stimulus.outcome.appliedAt,
        ),
      },
    ],
  });
}

function retryDelivery(
  state: EmailCoursePlanningState,
  current: ActiveCourseEmailIntent,
  stimulus: Extract<EmailCourseStimulus, { type: "DeliverySettled" }>,
): DecideEmailCourseResult {
  if (stimulus.outcome.type !== "TransientFailure") {
    return failure("Expected transient failure");
  }
  const availableAt = parseIsoInstant(
    new Date(Date.parse(stimulus.occurredAt) + RETRY_DELAY_MS).toISOString(),
  );
  if (!availableAt.ok) return failure(availableAt.error.reason);
  const intent: RetryWaitingCourseEmailIntent = {
    ...current,
    status: "RetryWaiting",
    availableAt: availableAt.value,
    activeSlot: EMAIL_COURSE_ACTIVE_SLOT,
    attempt: current.attempt + 1,
    lastFailure: stimulus.outcome.reason,
  };
  return accepted({
    next:
      state.run.phase === "sequenceExhausted"
        ? { ...state.run, actorVersion: state.run.actorVersion + 1 }
        : {
            ...state.run,
            actorVersion: state.run.actorVersion + 1,
            phase: "active.retryWait",
            activeIntentId: current.id,
          },
    events: [
      {
        type: "DeliveryRecorded",
        intentId: current.id,
        outcome: stimulus.outcome,
        occurredAt: stimulus.occurredAt,
      },
    ],
    outboxChanges: [{ type: "ScheduleRetry", intent }],
  });
}

function holdAmbiguous(
  state: EmailCoursePlanningState,
  current: ActiveCourseEmailIntent,
  stimulus: Extract<EmailCourseStimulus, { type: "DeliverySettled" }>,
): DecideEmailCourseResult {
  if (stimulus.outcome.type !== "Ambiguous") {
    return failure("Expected ambiguous outcome");
  }
  const intent: HeldCourseEmailIntent = {
    ...current,
    status: "Held",
    activeSlot: EMAIL_COURSE_ACTIVE_SLOT,
    reason: "AmbiguousDeliveryOutcome",
  };
  return accepted({
    next:
      state.run.phase === "sequenceExhausted"
        ? { ...state.run, actorVersion: state.run.actorVersion + 1 }
        : {
            ...state.run,
            actorVersion: state.run.actorVersion + 1,
            phase: "active.awaitingDelivery",
            activeIntentId: current.id,
          },
    events: [
      {
        type: "DeliveryRecorded",
        intentId: current.id,
        outcome: stimulus.outcome,
        occurredAt: stimulus.occurredAt,
      },
    ],
    outboxChanges: [{ type: "Hold", intent }],
  });
}

function stopForAutomation(
  input: DecideEmailCourseInput,
  state: EmailCoursePlanningState,
): DecideEmailCourseResult {
  if (input.automationControl.type !== "Stopped") {
    return failure("Expected stopped automation");
  }
  const reason: CourseStopReason = {
    type: "AutomationStopped",
    reason: input.automationControl.reason,
  };
  if (state.run.phase === "sequenceExhausted") {
    return keepFinalAndHold(state, reason, input.stimulus.occurredAt);
  }
  const current = activeIntent(state.currentIntent);
  const outboxChanges = current
    ? [
        {
          type: "Hold" as const,
          intent: {
            ...current,
            status: "Held" as const,
            activeSlot: EMAIL_COURSE_ACTIVE_SLOT,
            reason: "AutomationStopped" as const,
          },
        },
      ]
    : [];
  return accepted({
    next: stoppedRun(state.run, reason, input.stimulus.occurredAt),
    events: [stoppedEvent(reason, input.stimulus.occurredAt)],
    outboxChanges,
  });
}

function stopForCommunication(
  input: DecideEmailCourseInput,
  state: EmailCoursePlanningState,
  stopReason: Extract<
    CourseStopReason,
    { type: "CommunicationStopped" }
  >["reason"],
  suppliedOutcome?: Extract<DeliveryOutcome, { type: "CommunicationStopped" }>,
): DecideEmailCourseResult {
  const current = activeIntent(state.currentIntent);
  const outcome =
    suppliedOutcome ??
    ({
      type: "CommunicationStopped",
      reason: stopReason,
      stoppedAt: input.stimulus.occurredAt,
    } as const);
  const reason: CourseStopReason = {
    type: "CommunicationStopped",
    reason: stopReason,
  };
  const outboxChanges = current
    ? [
        {
          type: "Settle" as const,
          intent: settledIntent(current, outcome, outcome.stoppedAt),
        },
      ]
    : [];
  if (state.run.phase === "sequenceExhausted") {
    return accepted({
      next: { ...state.run, actorVersion: state.run.actorVersion + 1 },
      events: [stoppedEvent(reason, input.stimulus.occurredAt)],
      outboxChanges,
    });
  }
  return accepted({
    next: stoppedRun(state.run, reason, input.stimulus.occurredAt),
    events: [stoppedEvent(reason, input.stimulus.occurredAt)],
    outboxChanges,
  });
}

function stopForPermanentRefusal(
  state: EmailCoursePlanningState,
  current: ActiveCourseEmailIntent,
  stimulus: Extract<EmailCourseStimulus, { type: "DeliverySettled" }>,
): DecideEmailCourseResult {
  if (stimulus.outcome.type !== "PermanentRefusal") {
    return failure("Expected permanent refusal");
  }
  const reason: CourseStopReason = {
    type: "PermanentDeliveryRefusal",
    reason: stimulus.outcome.reason,
  };
  const settled = settledIntent(
    current,
    stimulus.outcome,
    stimulus.outcome.refusedAt,
  );
  if (state.run.phase === "sequenceExhausted") {
    return accepted({
      next: { ...state.run, actorVersion: state.run.actorVersion + 1 },
      events: [
        {
          type: "DeliveryRecorded",
          intentId: current.id,
          outcome: stimulus.outcome,
          occurredAt: stimulus.occurredAt,
        },
      ],
      outboxChanges: [{ type: "Settle", intent: settled }],
    });
  }
  return accepted({
    next: stoppedRun(state.run, reason, stimulus.occurredAt),
    events: [
      {
        type: "DeliveryRecorded",
        intentId: current.id,
        outcome: stimulus.outcome,
        occurredAt: stimulus.occurredAt,
      },
      stoppedEvent(reason, stimulus.occurredAt),
    ],
    outboxChanges: [{ type: "Settle", intent: settled }],
  });
}

function keepFinalAndHold(
  state: EmailCoursePlanningState,
  reason: CourseStopReason,
  occurredAt: IsoInstant,
): DecideEmailCourseResult {
  const current = activeIntent(state.currentIntent);
  return accepted({
    next: { ...state.run, actorVersion: state.run.actorVersion + 1 },
    events: [stoppedEvent(reason, occurredAt)],
    outboxChanges: current
      ? [
          {
            type: "Hold",
            intent: {
              ...current,
              status: "Held",
              activeSlot: EMAIL_COURSE_ACTIVE_SLOT,
              reason: "AutomationStopped",
            },
          },
        ]
      : [],
  });
}

function stoppedRun(
  run: EmailCourseRun,
  reason: CourseStopReason,
  stoppedAt: IsoInstant,
): EmailCourseRun {
  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    contactId: run.contactId,
    courseId: run.courseId,
    definitionVersion: run.definitionVersion,
    entryEventId: run.entryEventId,
    scheduleEvidence: run.scheduleEvidence,
    actorVersion: run.actorVersion + 1,
    startedAt: run.startedAt,
    phase: "stopped",
    reason,
    stoppedAt,
  };
}

function stoppedEvent(reason: CourseStopReason, occurredAt: IsoInstant) {
  return {
    type: "CourseRunStopped" as const,
    reason,
    occurredAt,
  };
}

function settledIntent(
  current: ActiveCourseEmailIntent,
  outcome: SettledCourseEmailIntent["outcome"],
  settledAt: IsoInstant,
): SettledCourseEmailIntent {
  return {
    id: current.id,
    idempotencyKey: current.idempotencyKey,
    contactId: current.contactId,
    runId: current.runId,
    stepId: current.stepId,
    pathId: current.pathId,
    contentResourceId: current.contentResourceId,
    deliveryTargetId: current.deliveryTargetId,
    status: "Settled",
    settledAt,
    outcome,
    activeSlot: null,
  };
}

function pendingIntent(args: {
  readonly runId: EmailCoursePlanningState["run"]["runId"];
  readonly contactId: EmailCoursePlanningState["run"]["contactId"];
  readonly step: EmailCourseStepDefinition;
  readonly availableAt: IsoInstant;
}): PendingCourseEmailIntent {
  const idempotencyKey = courseIntentKey({
    contactId: args.contactId,
    pathId: args.step.pathId,
    contentResourceId: args.step.contentResourceId,
  });
  const id = parseIntentId(`email-course-intent:${digest(idempotencyKey)}`);
  if (!id.ok) throw new Error(id.error.reason);
  return {
    status: "Pending",
    id: id.value,
    idempotencyKey,
    contactId: args.contactId,
    runId: args.runId,
    stepId: args.step.stepId,
    pathId: args.step.pathId,
    contentResourceId: args.step.contentResourceId,
    deliveryTargetId: args.step.deliveryTargetId,
    availableAt: args.availableAt,
    activeSlot: EMAIL_COURSE_ACTIVE_SLOT,
    attempt: 0,
  };
}

function exhaustionFactId(runId: string, pathId: CoursePathId) {
  const result = parseEventId(
    `email-course-exhausted:${digest(`${runId}:${pathId}`)}`,
  );
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

function findStep(
  definition: EmailCourseDefinition,
  stepId: CourseStepId,
): EmailCourseStepDefinition | null {
  for (const path of definition.paths) {
    const step = path.steps.find((candidate) => candidate.stepId === stepId);
    if (step) return step;
  }
  return null;
}

function activeIntent(
  intent: CourseEmailIntent | null,
): ActiveCourseEmailIntent | null {
  return intent && intent.status !== "Settled" ? intent : null;
}

function isFinalWithoutSettleableIntent(
  state: EmailCoursePlanningState,
  stimulus: EmailCourseStimulus,
): boolean {
  return (
    (state.run.phase === "sequenceExhausted" ||
      state.run.phase === "stopped") &&
    stimulus.type !== "DeliverySettled"
  );
}

function accepted(
  decision: Omit<Extract<EmailCourseDecision, { type: "Accepted" }>, "type">,
): DecideEmailCourseResult {
  return { ok: true, decision: { type: "Accepted", ...decision } };
}

function failure(reason: string): DecideEmailCourseResult {
  return { ok: false, reason };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
