import { formatInTimeZone, zonedTimeToUtc } from "date-fns-tz";
import { Effect } from "effect";

import type { ScheduleEvidence } from "./domain";
import { parseIsoInstant, type IsoInstant } from "./primitives";
import type {
  CourseScheduleDecision,
  EmailCourseCommandError,
  EmailCourseScheduler,
} from "./ports";

const HOUR_MS = 60 * 60 * 1000;

export type EmailCourseScheduleCalculationResult =
  | { readonly ok: true; readonly value: CourseScheduleDecision }
  | { readonly ok: false; readonly reason: string };

export function calculateNextEmailAvailableAt(args: {
  readonly settledAt: IsoInstant;
  readonly scheduleEvidence: ScheduleEvidence;
}): EmailCourseScheduleCalculationResult {
  const settledAt = new Date(args.settledAt);
  if (Number.isNaN(settledAt.getTime())) {
    return { ok: false, reason: "Settled instant is invalid" };
  }

  if (args.scheduleEvidence.type === "ExplicitFallback") {
    return scheduleDecision(
      new Date(settledAt.getTime() + 24 * HOUR_MS),
      "ExplicitTwentyFourHourFallback",
    );
  }

  try {
    const minimum = new Date(settledAt.getTime() + 18 * HOUR_MS);
    const completedLocalDate = formatInTimeZone(
      settledAt,
      args.scheduleEvidence.timeZone,
      "yyyy-MM-dd",
    );
    const nextLocalNine = zonedTimeToUtc(
      `${addLocalDays(completedLocalDate, 1)} 09:00:00`,
      args.scheduleEvidence.timeZone,
    );
    return scheduleDecision(
      minimum.getTime() >= nextLocalNine.getTime() ? minimum : nextLocalNine,
      "EighteenHourFloorThenLocalNine",
    );
  } catch (cause) {
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function createEmailCourseScheduler(): EmailCourseScheduler {
  return {
    nextAvailableAt: (args) => {
      const result = calculateNextEmailAvailableAt(args);
      return result.ok
        ? Effect.succeed(result.value)
        : Effect.fail({
            type: "CourseScheduleFailure",
            reason: result.reason,
          } satisfies EmailCourseCommandError);
    },
  };
}

function scheduleDecision(
  date: Date,
  policy: CourseScheduleDecision["policy"],
): EmailCourseScheduleCalculationResult {
  const availableAt = parseIsoInstant(date.toISOString());
  return availableAt.ok
    ? { ok: true, value: { availableAt: availableAt.value, policy } }
    : { ok: false, reason: availableAt.error.reason };
}

function addLocalDays(date: string, days: number): string {
  const noonUtc = new Date(`${date}T12:00:00.000Z`);
  noonUtc.setUTCDate(noonUtc.getUTCDate() + days);
  return noonUtc.toISOString().slice(0, 10);
}
