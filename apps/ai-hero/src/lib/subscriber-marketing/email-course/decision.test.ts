import { describe, expect, it } from "vitest";

import { decideEmailCourse } from "./decision";
import { AI_HERO_SKILLS_WORKFLOW_COURSE_V1 } from "./definition";
import type {
  AutomationControl,
  CommunicationDecision,
  EmailCoursePlanningState,
  EmailCourseStimulus,
  PendingCourseEmailIntent,
  ScheduleEvidence,
} from "./domain";
import {
  courseIntentKey,
  deriveCourseRunId,
  parseContactId,
  parseCourseId,
  parseCoursePathId,
  parseCourseStepId,
  parseEventId,
  parseIntentId,
  parseIsoInstant,
  parseStimulusId,
  type ParseResult,
} from "./primitives";
import type { CourseScheduleDecision } from "./ports";

const occurredAt = instant("2026-09-01T16:00:00.000Z");
const contactId = value(parseContactId("contact-decision"));
const courseId = value(parseCourseId("skills-workflow"));
const entryEventId = value(parseEventId("entry-decision"));
const runId = deriveCourseRunId({ courseId, entryEventId });
const allow: CommunicationDecision = { type: "Allow" };
const enabled: AutomationControl = {
  type: "Enabled",
  version: "control-v1",
  enabledAt: occurredAt,
};
const fallback: ScheduleEvidence = {
  type: "ExplicitFallback",
  reason: "header-missing",
  timeZone: "America/Los_Angeles",
  capturedAt: occurredAt,
};
const schedule: CourseScheduleDecision = {
  availableAt: instant("2026-09-02T16:00:00.000Z"),
  policy: "ExplicitTwentyFourHourFallback",
};

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
      scheduleEvidence: fallback,
      actorVersion: 8,
      startedAt: occurredAt,
      phase: "sequenceExhausted",
      exhaustionFactId: value(parseEventId("terminal-fact-decision")),
      exhaustedAt: occurredAt,
      terminalIntentId: active.currentIntent.id,
      terminalStepId: active.currentIntent.stepId,
    },
    currentIntent: active.currentIntent,
  };
}

function signup(stimulusName = "signup-decision"): EmailCourseStimulus {
  return {
    type: "ExplicitSignup",
    stimulusId: value(parseStimulusId(stimulusName)),
    contactId,
    courseId,
    entryEventId,
    scheduleEvidence: fallback,
    occurredAt,
  };
}

function activeAt(
  position: number,
  actorVersion = position + 1,
  phase:
    | "active.awaitingDelivery"
    | "active.awaitingNextDue" = "active.awaitingDelivery",
): EmailCoursePlanningState {
  const step = AI_HERO_SKILLS_WORKFLOW_COURSE_V1.paths[0].steps[position];
  if (!step) throw new Error(`Missing step ${position}`);
  const intentId = value(parseIntentId(`intent-${position}`));
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
      scheduleEvidence: fallback,
      actorVersion,
      startedAt: occurredAt,
      phase,
      activeIntentId: intent.id,
    },
    currentIntent: intent,
  };
}

describe("decideEmailCourse", () => {
  it("starts a course and plans Email 0 due now", () => {
    const result = decideEmailCourse({
      definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      state: null,
      stimulus: signup(),
      automationControl: enabled,
      communication: allow,
      schedule: null,
    });

    expect(result).toMatchObject({
      ok: true,
      decision: {
        type: "Accepted",
        next: {
          runId,
          actorVersion: 1,
          phase: "active.awaitingDelivery",
        },
        events: [
          { type: "CourseRunStarted" },
          {
            type: "NextEmailPlanned",
            stepId: "individual.email-0",
            availableAt: occurredAt,
          },
        ],
        outboxChanges: [
          {
            type: "Plan",
            intent: {
              status: "Pending",
              stepId: "individual.email-0",
              availableAt: occurredAt,
              activeSlot: "next",
            },
          },
        ],
      },
    });
  });

  it("settles delivery and plans the next due intent", () => {
    const state = activeAt(0);
    const result = decideEmailCourse({
      definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      state,
      stimulus: {
        type: "DeliverySettled",
        stimulusId: value(parseStimulusId("delivery-email-0")),
        runId,
        intentId: state.currentIntent!.id,
        outcome: {
          type: "Applied",
          deliveryReceiptId: "provider-receipt-0",
          appliedAt: occurredAt,
        },
        occurredAt,
      },
      automationControl: enabled,
      communication: allow,
      schedule,
    });

    expect(result).toMatchObject({
      ok: true,
      decision: {
        type: "Accepted",
        next: {
          actorVersion: 2,
          phase: "active.awaitingNextDue",
        },
        outboxChanges: [
          { type: "Settle", intent: { id: "intent-0", status: "Settled" } },
          {
            type: "Plan",
            intent: {
              stepId: "individual.email-1",
              availableAt: schedule.availableAt,
              activeSlot: "next",
            },
          },
        ],
      },
    });
  });

  it.each([
    {
      name: "automation control stops",
      automationControl: {
        type: "Stopped" as const,
        source: "Persisted" as const,
        version: "control-v2",
        reason: "operator-stop",
        stoppedAt: occurredAt,
      },
      communication: allow,
      expectedReason: { type: "AutomationStopped", reason: "operator-stop" },
    },
    {
      name: "communication safety stops",
      automationControl: enabled,
      communication: { type: "Stop" as const, reason: "Unsubscribed" as const },
      expectedReason: {
        type: "CommunicationStopped",
        reason: "Unsubscribed",
      },
    },
  ])("settles an applied delivery before $name the next plan", (scenario) => {
    const state = activeAt(0);
    const outcome = {
      type: "Applied" as const,
      deliveryReceiptId: "provider-receipt-before-stop",
      appliedAt: occurredAt,
    };
    const result = decideEmailCourse({
      definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      state,
      stimulus: {
        type: "DeliverySettled",
        stimulusId: value(parseStimulusId(`delivery-stop-${scenario.name}`)),
        runId,
        intentId: state.currentIntent!.id,
        outcome,
        occurredAt,
      },
      automationControl: scenario.automationControl,
      communication: scenario.communication,
      schedule: null,
    });

    expect(result).toMatchObject({
      ok: true,
      decision: {
        type: "Accepted",
        next: { phase: "stopped", reason: scenario.expectedReason },
        events: [
          { type: "DeliveryRecorded", outcome },
          { type: "CourseRunStopped", reason: scenario.expectedReason },
        ],
        outboxChanges: [
          {
            type: "Settle",
            intent: {
              status: "Settled",
              outcome,
              activeSlot: null,
            },
          },
        ],
      },
    });
  });

  it.each([
    {
      name: "automation control stops",
      automationControl: {
        type: "Stopped" as const,
        source: "Persisted" as const,
        version: "control-v2",
        reason: "operator-stop",
        stoppedAt: occurredAt,
      },
      communication: allow,
    },
    {
      name: "communication safety stops",
      automationControl: enabled,
      communication: { type: "Stop" as const, reason: "Unsubscribed" as const },
    },
  ])("settles terminal Email 7 before $name", (scenario) => {
    const state = terminalState();
    const outcome = {
      type: "Applied" as const,
      deliveryReceiptId: "provider-receipt-terminal-stop",
      appliedAt: occurredAt,
    };
    const result = decideEmailCourse({
      definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      state,
      stimulus: {
        type: "DeliverySettled",
        stimulusId: value(parseStimulusId(`terminal-stop-${scenario.name}`)),
        runId,
        intentId: state.currentIntent!.id,
        outcome,
        occurredAt,
      },
      automationControl: scenario.automationControl,
      communication: scenario.communication,
      schedule: null,
    });

    expect(result).toMatchObject({
      ok: true,
      decision: {
        type: "Accepted",
        next: { phase: "sequenceExhausted", actorVersion: 9 },
        events: [{ type: "DeliveryRecorded", outcome }],
        outboxChanges: [
          {
            type: "Settle",
            intent: { status: "Settled", outcome, activeSlot: null },
          },
        ],
      },
    });
    if (!result.ok || result.decision.type !== "Accepted") {
      throw new Error("Expected terminal settlement");
    }
    expect(
      result.decision.events.some((event) => event.type === "CourseRunStopped"),
    ).toBe(false);
  });

  it("repaths the unsent next intent and accelerates it to now", () => {
    const state = activeAt(1, 2, "active.awaitingNextDue");
    const selectedPathId = value(
      parseCoursePathId("ai-hero-skills-team-workflow"),
    );
    const selectedNextStepId = value(parseCourseStepId("team.email-1"));
    const result = decideEmailCourse({
      definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      state,
      stimulus: {
        type: "AnswerSelected",
        stimulusId: value(parseStimulusId("answer-email-0-team")),
        runId,
        answerEventId: value(parseEventId("answer-event-team")),
        sentStepId: value(parseCourseStepId("individual.email-0")),
        selectedPathId,
        selectedNextStepId,
        occurredAt,
      },
      automationControl: enabled,
      communication: allow,
      schedule: null,
    });

    expect(result).toMatchObject({
      ok: true,
      decision: {
        type: "Accepted",
        next: {
          actorVersion: 3,
          phase: "active.awaitingDelivery",
        },
        events: [
          { type: "AnswerObserved" },
          {
            type: "NextEmailRouteChanged",
            fromStepId: "individual.email-1",
            toStepId: "team.email-1",
          },
          { type: "NextEmailAccelerated", availableAt: occurredAt },
        ],
        outboxChanges: [
          {
            type: "ReplaceRoute",
            expectedIntentId: state.currentIntent!.id,
            replacement: {
              pathId: selectedPathId,
              stepId: selectedNextStepId,
              availableAt: occurredAt,
            },
          },
        ],
      },
    });
  });

  it("commits terminal Email 7 and sequence exhaustion together", () => {
    const state = activeAt(6, 7);
    const result = decideEmailCourse({
      definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      state,
      stimulus: {
        type: "DeliverySettled",
        stimulusId: value(parseStimulusId("delivery-email-6")),
        runId,
        intentId: state.currentIntent!.id,
        outcome: {
          type: "Applied",
          deliveryReceiptId: "provider-receipt-6",
          appliedAt: occurredAt,
        },
        occurredAt,
      },
      automationControl: enabled,
      communication: allow,
      schedule,
    });

    expect(result).toMatchObject({
      ok: true,
      decision: {
        type: "Accepted",
        next: {
          actorVersion: 8,
          phase: "sequenceExhausted",
          terminalStepId: "individual.email-7",
          exhaustedAt: occurredAt,
        },
        outboxChanges: [
          { type: "Settle", intent: { id: "intent-6" } },
          {
            type: "Plan",
            intent: {
              stepId: "individual.email-7",
              availableAt: schedule.availableAt,
            },
          },
        ],
      },
    });
    if (!result.ok || result.decision.type !== "Accepted") {
      throw new Error("Expected accepted terminal decision");
    }
    expect(
      result.decision.events.filter(
        (event) => event.type === "CourseSequenceExhausted",
      ),
    ).toHaveLength(1);
  });

  it("records a missing-control hard stop without provider work", () => {
    const result = decideEmailCourse({
      definition: AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      state: null,
      stimulus: signup("signup-stopped"),
      automationControl: {
        type: "Stopped",
        source: "Missing",
        version: null,
        reason: "MissingControl",
        stoppedAt: null,
      },
      communication: allow,
      schedule: null,
    });

    expect(result).toMatchObject({
      ok: true,
      decision: {
        type: "Accepted",
        next: {
          phase: "stopped",
          reason: { type: "AutomationStopped", reason: "MissingControl" },
        },
        events: [
          { type: "CourseRunStarted" },
          {
            type: "CourseRunStopped",
            reason: { type: "AutomationStopped" },
          },
        ],
        outboxChanges: [],
      },
    });
  });
});

function instant(input: string) {
  return value(parseIsoInstant(input));
}

function value<Value>(result: ParseResult<Value>): Value {
  if (result.ok) return result.value;
  throw new Error(result.error.reason);
}
