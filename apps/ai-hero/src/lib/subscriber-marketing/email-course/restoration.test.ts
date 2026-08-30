import { describe, expect, it } from "vitest";

import { AI_HERO_SKILLS_WORKFLOW_COURSE_V1 } from "./definition";
import {
  restoreAutomationControl,
  restoreCommunicationDecision,
  restoreCourseEmailIntent,
  restoreEmailCourseRun,
  restoreEmailCourseView,
} from "./restoration";

const runId = "email-course:skills-workflow:event-entry";
const pendingIntent = {
  status: "Pending",
  id: "intent-0",
  idempotencyKey:
    "contact:contact-1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0",
  contactId: "contact-1",
  runId,
  stepId: "individual.email-0",
  pathId: "ai-hero-skills-workflow",
  contentResourceId: "ai-hero-skills-workflow.email-0",
  deliveryTargetId: "skills-workflow.individual.email-0",
  availableAt: "2026-08-30T16:00:00.000Z",
  activeSlot: "next",
  attempt: 0,
};
const runBase = {
  schemaVersion: 1,
  runId,
  contactId: "contact-1",
  courseId: "skills-workflow",
  definitionVersion: "skills-workflow.v1",
  entryEventId: "event-entry",
  scheduleEvidence: {
    type: "BrowserEntryHeader",
    headerName: "x-vercel-ip-timezone",
    timeZone: "America/Los_Angeles",
    capturedAt: "2026-08-30T16:00:00.000Z",
  },
  actorVersion: 1,
  startedAt: "2026-08-30T16:00:00.000Z",
};

describe("email course restoration", () => {
  it("restores a course run that references its outbox intent", () => {
    expect(
      restoreEmailCourseRun(
        {
          ...runBase,
          phase: "active.awaitingDelivery",
          activeIntentId: "intent-0",
        },
        AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        phase: "active.awaitingDelivery",
        runId,
        activeIntentId: "intent-0",
      },
    });
  });

  it("rejects a run id that does not match the course entry", () => {
    expect(
      restoreEmailCourseRun(
        {
          ...runBase,
          runId: "email-course:skills-workflow:event-other",
          phase: "active.awaitingNextDue",
          activeIntentId: "intent-1",
        },
        AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      ),
    ).toEqual({
      ok: false,
      error: {
        type: "CourseRunDecodeFailure",
        reason: "Run identity does not match its course entry",
      },
    });
  });

  it("settles terminal Email 7 after the planner reaches sequence exhaustion", () => {
    expect(
      restoreEmailCourseRun(
        {
          ...runBase,
          phase: "sequenceExhausted",
          exhaustionFactId: "fact-1",
          exhaustedAt: "2026-08-30T16:00:00.000Z",
          terminalIntentId: "intent-7",
          terminalStepId: "individual.email-7",
        },
        AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      ),
    ).toMatchObject({ ok: true, value: { phase: "sequenceExhausted" } });
    expect(
      restoreCourseEmailIntent(
        {
          ...pendingIntent,
          status: "Settled",
          id: "intent-7",
          idempotencyKey:
            "contact:contact-1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-7",
          stepId: "individual.email-7",
          contentResourceId: "ai-hero-skills-workflow.email-7",
          deliveryTargetId: "skills-workflow.individual.email-7",
          settledAt: "2026-08-30T17:00:00.000Z",
          outcome: {
            type: "Applied",
            deliveryReceiptId: "delivery-receipt-7",
            appliedAt: "2026-08-30T17:00:00.000Z",
          },
          activeSlot: null,
          availableAt: undefined,
          attempt: undefined,
        },
        AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      ),
    ).toMatchObject({
      ok: true,
      value: { status: "Settled", activeSlot: null },
    });
  });

  it("rejects sequence exhaustion on a nonterminal step", () => {
    expect(
      restoreEmailCourseRun(
        {
          ...runBase,
          phase: "sequenceExhausted",
          exhaustionFactId: "fact-1",
          exhaustedAt: "2026-08-30T16:00:00.000Z",
          terminalIntentId: "intent-0",
          terminalStepId: "individual.email-0",
        },
        AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      ),
    ).toEqual({
      ok: false,
      error: {
        type: "CourseRunDecodeFailure",
        reason: "Sequence exhaustion does not reference a terminal step",
      },
    });
  });

  it("restores a held intent but rejects a mismatched replay key", () => {
    expect(
      restoreCourseEmailIntent(
        {
          ...pendingIntent,
          status: "Held",
          reason: "AmbiguousDeliveryOutcome",
        },
        AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      ),
    ).toMatchObject({
      ok: true,
      value: { status: "Held", reason: "AmbiguousDeliveryOutcome" },
    });
    expect(
      restoreCourseEmailIntent(
        { ...pendingIntent, idempotencyKey: "wrong-key" },
        AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      ),
    ).toEqual({
      ok: false,
      error: {
        type: "CourseRunDecodeFailure",
        reason: "Intent idempotency key does not match its identity",
      },
    });
  });

  it("rejects an intent whose target does not match its defined step", () => {
    expect(
      restoreCourseEmailIntent(
        {
          ...pendingIntent,
          deliveryTargetId: "skills-workflow.team.email-0",
        },
        AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      ),
    ).toEqual({
      ok: false,
      error: {
        type: "CourseRunDecodeFailure",
        reason: "Intent does not match the course definition",
      },
    });
  });

  it("rejects a view that pairs a run with another run's intent", () => {
    expect(
      restoreEmailCourseView(
        {
          run: {
            ...runBase,
            phase: "active.awaitingDelivery",
            activeIntentId: "intent-0",
          },
          currentIntent: {
            ...pendingIntent,
            runId: "email-course:skills-workflow:event-other",
          },
          communication: { type: "Allow" },
          automationControl: null,
        },
        AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      ),
    ).toEqual({
      ok: false,
      error: {
        type: "CourseRunDecodeFailure",
        reason: "Awaiting-delivery run has an incompatible intent",
      },
    });
  });

  it("restores a relation-safe run inspection view", () => {
    expect(
      restoreEmailCourseView(
        {
          run: {
            ...runBase,
            phase: "active.awaitingDelivery",
            activeIntentId: "intent-0",
          },
          currentIntent: pendingIntent,
          communication: { type: "Allow" },
          automationControl: null,
        },
        AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        run: { runId, activeIntentId: "intent-0" },
        currentIntent: { runId, id: "intent-0", status: "Pending" },
        automationControl: { type: "Stopped", source: "Missing" },
      },
    });
  });

  it("requires Pacific time for explicit fallback evidence", () => {
    expect(
      restoreEmailCourseRun(
        {
          ...runBase,
          phase: "active.awaitingDelivery",
          activeIntentId: "intent-0",
          scheduleEvidence: {
            type: "ExplicitFallback",
            reason: "header-missing",
            timeZone: "America/New_York",
            capturedAt: "2026-08-30T16:00:00.000Z",
          },
        },
        AI_HERO_SKILLS_WORKFLOW_COURSE_V1,
      ),
    ).toMatchObject({
      ok: false,
      error: { type: "CourseRunDecodeFailure" },
    });
  });

  it("decodes missing durable control as stopped", () => {
    expect(restoreAutomationControl(null)).toEqual({
      ok: true,
      value: {
        type: "Stopped",
        source: "Missing",
        version: null,
        reason: "MissingControl",
        stoppedAt: null,
      },
    });
  });

  it("restores explicit automation and communication decisions", () => {
    expect(
      restoreAutomationControl({
        type: "Stopped",
        version: "control-v1",
        reason: "operator maintenance",
        stoppedAt: "2026-08-30T16:00:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: { type: "Stopped", source: "Persisted" },
    });
    expect(
      restoreCommunicationDecision({
        type: "Stop",
        reason: "Complained",
      }),
    ).toEqual({
      ok: true,
      value: { type: "Stop", reason: "Complained" },
    });
  });
});
