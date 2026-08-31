import { describe, expect, it } from "vitest";

import { decideEmailCourse } from "./decision";
import { AI_HERO_SKILLS_WORKFLOW_COURSE_V1 } from "./definition";
import type {
  AutomationControl,
  CommunicationDecision,
  EmailCourseDecision,
  EmailCoursePlanningState,
  EmailCourseStimulus,
  PendingCourseEmailIntent,
  ScheduleEvidence,
} from "./domain";
import { normalizeEmailCourseTransitionReceipts } from "./parity-receipt";
import {
  courseIntentKey,
  deriveCourseRunId,
  parseContactId,
  parseCourseId,
  parseEventId,
  parseIntentId,
  parseIsoInstant,
  parseStimulusId,
  type ParseResult,
} from "./primitives";
import type { CourseScheduleDecision } from "./ports";

const occurredAt = instant("2026-09-01T16:00:00.000Z");
const contactId = value(parseContactId("contact-parity"));
const courseId = value(parseCourseId("skills-workflow"));
const entryEventId = value(parseEventId("entry-parity"));
const runId = deriveCourseRunId({ courseId, entryEventId });
const enabled: AutomationControl = {
  type: "Enabled",
  version: "control-parity-v1",
  enabledAt: occurredAt,
};
const allow: CommunicationDecision = { type: "Allow" };
const scheduleEvidence: ScheduleEvidence = {
  type: "ExplicitFallback",
  reason: "header-missing",
  timeZone: "America/Los_Angeles",
  capturedAt: occurredAt,
};
const schedule: CourseScheduleDecision = {
  availableAt: instant("2026-09-02T16:00:00.000Z"),
  policy: "ExplicitTwentyFourHourFallback",
};

describe("Email Course Drovr parity mapping", () => {
  it("maps signup to drovr's cold-start pending self-transition", () => {
    const stimulus = signup();
    const decision = accepted(
      decideEmailCourse({
        definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
        state: null,
        stimulus,
        automationControl: enabled,
        communication: allow,
        schedule: null,
      }),
    );

    expect(pairs(receipts(null, stimulus, decision))).toEqual([
      ["email0.pending", "email0.pending"],
    ]);
  });

  it("maps applied settlement from pending to waiting", () => {
    const transition = settleAt(0);

    expect(pairs(transition.receipts)[0]).toEqual([
      "email0.pending",
      "email0.waiting",
    ]);
  });

  it("maps the drip-next plan from waiting to the next pending email", () => {
    const transition = settleAt(0);

    expect(pairs(transition.receipts)[1]).toEqual([
      "email0.waiting",
      "email1.pending",
    ]);
  });

  it("maps answer-selected progression from the sent email's waiting state", () => {
    const previous = activeAt(1);
    const sentStep = AI_HERO_SKILLS_WORKFLOW_COURSE_V1.paths[0].steps[0]!;
    const selectedStep = AI_HERO_SKILLS_WORKFLOW_COURSE_V1.paths[0].steps[1]!;
    const stimulus: EmailCourseStimulus = {
      type: "AnswerSelected",
      stimulusId: value(parseStimulusId("answer-email-0-parity")),
      runId,
      answerEventId: value(parseEventId("answer-event-email-0-parity")),
      sentStepId: sentStep.stepId,
      selectedPathId: selectedStep.pathId,
      selectedNextStepId: selectedStep.stepId,
      occurredAt,
    };
    const decision = accepted(
      decideEmailCourse({
        definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
        state: previous,
        stimulus,
        automationControl: enabled,
        communication: allow,
        schedule: null,
      }),
    );

    expect(pairs(receipts(previous, stimulus, decision))).toEqual([
      ["email0.waiting", "email1.pending"],
    ]);
  });

  it("maps terminal Email 7 settlement from pending to completed", () => {
    const previous = terminalState();
    const stimulus = applied(previous, "settle-email-7-parity");
    const decision = accepted(
      decideEmailCourse({
        definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
        state: previous,
        stimulus,
        automationControl: enabled,
        communication: allow,
        schedule: null,
      }),
    );

    expect(pairs(receipts(previous, stimulus, decision))).toEqual([
      ["email7.pending", "completed"],
    ]);
  });
});

function settleAt(position: number) {
  const previous = activeAt(position);
  const stimulus = applied(previous, `settle-email-${position}-parity`);
  const decision = accepted(
    decideEmailCourse({
      definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      state: previous,
      stimulus,
      automationControl: enabled,
      communication: allow,
      schedule,
    }),
  );
  return {
    previous,
    stimulus,
    decision,
    receipts: receipts(previous, stimulus, decision),
  };
}

function receipts(
  previous: EmailCoursePlanningState | null,
  stimulus: EmailCourseStimulus,
  decision: Extract<EmailCourseDecision, { type: "Accepted" }>,
) {
  return normalizeEmailCourseTransitionReceipts({
    definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
    previous,
    stimulus,
    decision,
  });
}

function pairs(
  transitionReceipts: readonly { fromState: string; toState: string }[],
) {
  return transitionReceipts.map((receipt) => [
    receipt.fromState,
    receipt.toState,
  ]);
}

function signup(): EmailCourseStimulus {
  return {
    type: "ExplicitSignup",
    stimulusId: value(parseStimulusId("signup-parity")),
    contactId,
    courseId,
    entryEventId,
    scheduleEvidence,
    occurredAt,
  };
}

function applied(
  state: EmailCoursePlanningState,
  stimulusId: string,
): EmailCourseStimulus {
  if (!state.currentIntent) throw new Error("Expected a current intent");
  return {
    type: "DeliverySettled",
    stimulusId: value(parseStimulusId(stimulusId)),
    runId,
    intentId: state.currentIntent.id,
    outcome: {
      type: "Applied",
      deliveryReceiptId: `${stimulusId}-receipt`,
      appliedAt: occurredAt,
    },
    occurredAt,
  };
}

function terminalState(): EmailCoursePlanningState {
  const active = activeAt(7, 8);
  if (!active.currentIntent) throw new Error("Expected terminal intent");
  return {
    run: {
      schemaVersion: 1,
      runId,
      contactId,
      courseId,
      definitionVersion: AI_HERO_SKILLS_WORKFLOW_COURSE_V1.version,
      entryEventId,
      scheduleEvidence,
      actorVersion: 8,
      startedAt: occurredAt,
      phase: "sequenceExhausted",
      exhaustionFactId: value(parseEventId("terminal-fact-parity")),
      exhaustedAt: occurredAt,
      terminalIntentId: active.currentIntent.id,
      terminalStepId: active.currentIntent.stepId,
    },
    currentIntent: active.currentIntent,
  };
}

function activeAt(
  position: number,
  actorVersion = position + 1,
): EmailCoursePlanningState {
  const step = AI_HERO_SKILLS_WORKFLOW_COURSE_V1.paths[0].steps[position];
  if (!step) throw new Error(`Missing step ${position}`);
  const intentId = value(parseIntentId(`intent-parity-${position}`));
  const intent: PendingCourseEmailIntent = {
    status: "Pending",
    id: intentId,
    idempotencyKey: courseIntentKey({
      contactId,
      pathId: step.pathId,
      contentResourceId: step.contentResourceId,
    }),
    contactId,
    runId,
    stepId: step.stepId,
    pathId: step.pathId,
    contentResourceId: step.contentResourceId,
    deliveryTargetId: step.deliveryTargetId,
    availableAt: occurredAt,
    activeSlot: "next",
    attempt: 0,
  };
  return {
    run: {
      schemaVersion: 1,
      runId,
      contactId,
      courseId,
      definitionVersion: AI_HERO_SKILLS_WORKFLOW_COURSE_V1.version,
      entryEventId,
      scheduleEvidence,
      actorVersion,
      startedAt: occurredAt,
      phase: "active.awaitingDelivery",
      activeIntentId: intent.id,
    },
    currentIntent: intent,
  };
}

function accepted(result: ReturnType<typeof decideEmailCourse>) {
  if (!result.ok || result.decision.type !== "Accepted") {
    throw new Error("Expected an accepted Email Course decision");
  }
  return result.decision;
}

function instant(valueToParse: string) {
  return value(parseIsoInstant(valueToParse));
}

function value<Value>(result: ParseResult<Value>): Value {
  if (result.ok) return result.value;
  throw new Error(result.error.reason);
}
