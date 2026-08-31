import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { AI_HERO_SKILLS_WORKFLOW_COURSE_V1 } from "./definition";
import type {
  AutomationControl,
  CommunicationDecision,
  EmailCoursePlanningState,
  EmailCourseStimulus,
} from "./domain";
import type { DrovrParityReceiptSink } from "./parity-receipt";
import {
  deriveCourseRunId,
  parseContactId,
  parseCourseId,
  parseEventId,
  parseIsoInstant,
  parseStimulusId,
  type ParseResult,
} from "./primitives";
import type {
  AdvanceEmailCourseResult,
  CommunicationSafetyPolicy,
  EmailCourseAutomationControlRepository,
  EmailCourseCommit,
  EmailCourseDefinitionRegistry,
  EmailCourseLedger,
  EmailCourseScheduler,
} from "./ports";
import { createAdvanceEmailCourse } from "./service";

const now = value(parseIsoInstant("2026-09-01T16:00:00.000Z"));
const courseId = value(parseCourseId("skills-workflow"));
const entryEventId = value(parseEventId("entry-service"));
const contactId = value(parseContactId("contact-service"));
const runId = deriveCourseRunId({ courseId, entryEventId });
const enabled: AutomationControl = {
  type: "Enabled",
  version: "control-v1",
  enabledAt: now,
};
const allow: CommunicationDecision = { type: "Allow" };

function signup(): EmailCourseStimulus {
  return {
    type: "ExplicitSignup",
    stimulusId: value(parseStimulusId("signup-service")),
    contactId,
    courseId,
    entryEventId,
    scheduleEvidence: {
      type: "ExplicitFallback",
      reason: "header-missing",
      timeZone: "America/Los_Angeles",
      capturedAt: now,
    },
    occurredAt: now,
  };
}

function dependencies(args: {
  ledger: EmailCourseLedger;
  sink: DrovrParityReceiptSink;
}) {
  const registry: EmailCourseDefinitionRegistry = {
    get: () => Effect.succeed(AI_HERO_SKILLS_WORKFLOW_COURSE_V1),
  };
  const control: EmailCourseAutomationControlRepository = {
    readEffective: () => Effect.succeed(enabled),
  };
  const communication: CommunicationSafetyPolicy = {
    decide: () => Effect.succeed(allow),
  };
  const scheduler: EmailCourseScheduler = {
    nextAvailableAt: () =>
      Effect.succeed({
        availableAt: value(parseIsoInstant("2026-09-02T16:00:00.000Z")),
        policy: "ExplicitTwentyFourHourFallback",
      }),
  };
  return {
    ledger: args.ledger,
    definitions: registry,
    controls: control,
    communication,
    scheduler,
    parityReceiptSink: args.sink,
  };
}

function memoryLedger(options: { conflicts?: number } = {}) {
  let state: EmailCoursePlanningState | null = null;
  const committed = new Map<string, AdvanceEmailCourseResult>();
  let conflicts = options.conflicts ?? 0;
  const commits: EmailCourseCommit[] = [];
  const ledger: EmailCourseLedger = {
    load: () => Effect.succeed(state),
    findCommittedStimulus: (stimulus) => {
      const result = committed.get(stimulus.stimulusId);
      return Effect.succeed(
        result
          ? {
              ...result,
              committed: false,
              replayedStimulus: true,
            }
          : null,
      );
    },
    commit: (candidate) => {
      if (conflicts > 0) {
        conflicts -= 1;
        return Effect.fail({
          type: "CourseRunVersionConflict",
          runId,
        });
      }
      commits.push(candidate);
      if (candidate.decision.type !== "Accepted") {
        throw new Error("Only accepted decisions are committed");
      }
      state = {
        run: candidate.decision.next,
        currentIntent: nextIntent(candidate),
      };
      const result: AdvanceEmailCourseResult = {
        decision: candidate.decision,
        committed: true,
        replayedStimulus: false,
      };
      committed.set(candidate.stimulus.stimulusId, result);
      return Effect.succeed(result);
    },
    inspectRun: () =>
      Effect.fail({
        type: "CourseInspectionUnavailable",
        reason: "not-used",
      }),
  };
  return { ledger, commits };
}

describe("advanceEmailCourse service", () => {
  it("pushes one normalized Drovr receipt only after the commit", async () => {
    const { ledger, commits } = memoryLedger();
    const pushed: unknown[] = [];
    const advance = createAdvanceEmailCourse(
      dependencies({
        ledger,
        sink: {
          push: (receipt) => Effect.sync(() => void pushed.push(receipt)),
        },
      }),
    );

    const first = await Effect.runPromise(advance({ stimulus: signup() }));
    const replay = await Effect.runPromise(advance({ stimulus: signup() }));

    expect(first).toMatchObject({ committed: true, replayedStimulus: false });
    expect(replay).toMatchObject({ committed: false, replayedStimulus: true });
    expect(commits).toHaveLength(1);
    expect(pushed).toEqual([
      expect.objectContaining({
        tenantId: "org-aihero-shadow",
        contactId,
        journeyId: "value-path-skills-course",
        journeyVersion: 1,
        fromState: "entry",
        toState: "email0.pending",
        cause: "journey.started",
        intentsEmitted: 1,
        at: now,
      }),
    ]);
  });

  it("returns the committed result when the parity sink defects", async () => {
    const { ledger } = memoryLedger();
    const advance = createAdvanceEmailCourse(
      dependencies({
        ledger,
        sink: { push: () => Effect.die(new Error("drovr unavailable")) },
      }),
    );

    await expect(
      Effect.runPromise(advance({ stimulus: signup() })),
    ).resolves.toMatchObject({ committed: true });
  });

  it("retries an optimistic version conflict before pushing parity", async () => {
    const { ledger, commits } = memoryLedger({ conflicts: 1 });
    const push = vi.fn(() => Effect.void);
    const advance = createAdvanceEmailCourse(
      dependencies({ ledger, sink: { push } }),
    );

    await expect(
      Effect.runPromise(advance({ stimulus: signup() })),
    ).resolves.toMatchObject({ committed: true });
    expect(commits).toHaveLength(1);
    expect(push).toHaveBeenCalledOnce();
  });
});

function nextIntent(commit: EmailCourseCommit) {
  if (commit.decision.type !== "Accepted") return null;
  for (const change of commit.decision.outboxChanges.toReversed()) {
    if (change.type === "Plan") return change.intent;
    if (change.type === "ReplaceRoute") return change.replacement;
    if (
      change.type === "Accelerate" ||
      change.type === "ScheduleRetry" ||
      change.type === "Hold" ||
      change.type === "Settle"
    ) {
      return change.intent;
    }
  }
  return null;
}

function value<Value>(result: ParseResult<Value>): Value {
  if (result.ok) return result.value;
  throw new Error(result.error.reason);
}
