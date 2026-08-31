import { Effect } from "effect";

import { decideEmailCourse } from "./decision";
import type {
  AutomationControl,
  CommunicationDecision,
  EmailCoursePlanningState,
} from "./domain";
import {
  normalizeEmailCourseTransitionReceipt,
  type DrovrParityReceiptSink,
} from "./parity-receipt";
import { deriveCourseRunId } from "./primitives";
import type {
  AdvanceEmailCourseCommand,
  AdvanceEmailCourseResult,
  CommunicationSafetyPolicy,
  CourseScheduleDecision,
  EmailCourseAutomationControlRepository,
  EmailCourseCommandError,
  EmailCourseCommit,
  EmailCourseDefinitionRegistry,
  EmailCourseLedger,
  EmailCourseScheduler,
} from "./ports";

const OPTIMISTIC_RETRY_LIMIT = 3;

export type AdvanceEmailCourseDependencies = {
  readonly ledger: EmailCourseLedger;
  readonly definitions: EmailCourseDefinitionRegistry;
  readonly controls: EmailCourseAutomationControlRepository;
  readonly communication: CommunicationSafetyPolicy;
  readonly scheduler: EmailCourseScheduler;
  readonly parityReceiptSink: DrovrParityReceiptSink;
};

export function advanceEmailCourse(
  command: AdvanceEmailCourseCommand,
  dependencies: AdvanceEmailCourseDependencies,
): Effect.Effect<AdvanceEmailCourseResult, EmailCourseCommandError> {
  return createAdvanceEmailCourse(dependencies)(command);
}

export function createAdvanceEmailCourse(
  dependencies: AdvanceEmailCourseDependencies,
): (
  command: AdvanceEmailCourseCommand,
) => Effect.Effect<AdvanceEmailCourseResult, EmailCourseCommandError> {
  const run = (
    command: AdvanceEmailCourseCommand,
    attempt: number,
  ): Effect.Effect<AdvanceEmailCourseResult, EmailCourseCommandError> =>
    Effect.gen(function* () {
      const replay = yield* dependencies.ledger.findCommittedStimulus(
        command.stimulus.stimulusId,
      );
      if (replay) return replay;

      const runId =
        command.stimulus.type === "ExplicitSignup"
          ? deriveCourseRunId({
              courseId: command.stimulus.courseId,
              entryEventId: command.stimulus.entryEventId,
            })
          : command.stimulus.runId;
      const previous = yield* dependencies.ledger.load(runId);
      if (command.stimulus.type !== "ExplicitSignup" && !previous) {
        return yield* Effect.fail({
          type: "CourseRunNotFound",
          runId,
        } satisfies EmailCourseCommandError);
      }
      const courseId =
        command.stimulus.type === "ExplicitSignup"
          ? command.stimulus.courseId
          : previous!.run.courseId;
      const definition = yield* dependencies.definitions.get(courseId);
      const automationControl =
        yield* dependencies.controls.readEffective(courseId);
      const communication = yield* dependencies.communication.decide(
        command.stimulus.type === "ExplicitSignup"
          ? command.stimulus.contactId
          : previous!.run.contactId,
      );
      const schedule = yield* scheduleForDecision({
        command,
        previous,
        automationControl,
        communication,
        scheduler: dependencies.scheduler,
      });
      const decided = decideEmailCourse({
        definition,
        state: previous,
        stimulus: command.stimulus,
        automationControl,
        communication,
        schedule,
      });
      if (!decided.ok) {
        return yield* Effect.fail({
          type: "CourseDecisionFailure",
          reason: decided.reason,
        } satisfies EmailCourseCommandError);
      }
      if (decided.decision.type === "Ignored") {
        return {
          decision: decided.decision,
          committed: false,
          replayedStimulus: false,
        };
      }

      const commit: EmailCourseCommit = {
        stimulus: command.stimulus,
        expectedVersion: previous?.run.actorVersion ?? null,
        previous,
        definition,
        automationControl,
        communication,
        decidedAt: command.stimulus.occurredAt,
        decision: decided.decision,
      };
      return yield* dependencies.ledger.commit(commit).pipe(
        Effect.flatMap((committed) => {
          if (!committed.committed || committed.decision.type !== "Accepted") {
            return Effect.succeed(committed);
          }
          const parityReceipt = normalizeEmailCourseTransitionReceipt({
            definition,
            previous,
            stimulus: command.stimulus,
            decision: committed.decision,
          });
          return dependencies.parityReceiptSink.push(parityReceipt).pipe(
            Effect.catchAllCause(() => Effect.void),
            Effect.as(committed),
          );
        }),
        Effect.catchAll((error) =>
          error.type === "CourseRunVersionConflict" &&
          attempt + 1 < OPTIMISTIC_RETRY_LIMIT
            ? run(command, attempt + 1)
            : Effect.fail(error),
        ),
      );
    });

  return (command) => run(command, 0);
}

function scheduleForDecision(args: {
  readonly command: AdvanceEmailCourseCommand;
  readonly previous: EmailCoursePlanningState | null;
  readonly automationControl: AutomationControl;
  readonly communication: CommunicationDecision;
  readonly scheduler: EmailCourseScheduler;
}): Effect.Effect<CourseScheduleDecision | null, EmailCourseCommandError> {
  const stimulus = args.command.stimulus;
  if (
    stimulus.type !== "DeliverySettled" ||
    stimulus.outcome.type !== "Applied" ||
    !args.previous ||
    args.previous.run.phase === "sequenceExhausted" ||
    args.previous.run.phase === "stopped" ||
    args.automationControl.type !== "Enabled" ||
    args.communication.type !== "Allow"
  ) {
    return Effect.succeed(null);
  }
  return args.scheduler.nextAvailableAt({
    settledAt: stimulus.outcome.appliedAt,
    scheduleEvidence: args.previous.run.scheduleEvidence,
  });
}
