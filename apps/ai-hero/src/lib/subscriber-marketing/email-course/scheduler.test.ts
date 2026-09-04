import { describe, expect, it } from "vitest";

import type { ScheduleEvidence } from "./domain";
import {
  calculateNextEmailAvailableAt,
  createEmailCourseScheduler,
} from "./scheduler";
import {
  parseIanaTimeZone,
  parseIsoInstant,
  type IanaTimeZone,
  type ParseResult,
} from "./primitives";
import { Effect } from "effect";

const instant = (input: string) => value(parseIsoInstant(input));
const timeZone = (input: string) => value(parseIanaTimeZone(input));

function browser(zone: IanaTimeZone): ScheduleEvidence {
  return {
    type: "BrowserEntryHeader",
    headerName: "x-vercel-ip-timezone",
    timeZone: zone,
    capturedAt: instant("2026-01-01T00:00:00.000Z"),
  };
}

function fallback(): ScheduleEvidence {
  return {
    type: "ExplicitFallback",
    reason: "header-missing",
    timeZone: "America/Los_Angeles",
    capturedAt: instant("2026-01-01T00:00:00.000Z"),
  };
}

describe("Email Course scheduler", () => {
  it("keeps the 18-hour floor when next-local-day 09:00 is earlier", () => {
    expect(
      calculateNextEmailAvailableAt({
        settledAt: instant("2026-03-07T23:00:00.000Z"),
        scheduleEvidence: browser(timeZone("America/Los_Angeles")),
      }),
    ).toEqual({
      ok: true,
      value: {
        availableAt: instant("2026-03-08T17:00:00.000Z"),
        policy: "EighteenHourFloorThenLocalNine",
      },
    });
  });

  it("uses local 09:00 across the spring DST transition", () => {
    expect(
      calculateNextEmailAvailableAt({
        settledAt: instant("2026-03-07T18:00:00.000Z"),
        scheduleEvidence: browser(timeZone("America/Los_Angeles")),
      }),
    ).toEqual({
      ok: true,
      value: {
        availableAt: instant("2026-03-08T16:00:00.000Z"),
        policy: "EighteenHourFloorThenLocalNine",
      },
    });
  });

  it("uses local 09:00 across the fall DST transition", () => {
    expect(
      calculateNextEmailAvailableAt({
        settledAt: instant("2026-10-31T18:00:00.000Z"),
        scheduleEvidence: browser(timeZone("America/Los_Angeles")),
      }),
    ).toEqual({
      ok: true,
      value: {
        availableAt: instant("2026-11-01T17:00:00.000Z"),
        policy: "EighteenHourFloorThenLocalNine",
      },
    });
  });

  it("uses the explicit 24-hour Pacific fallback without local-time inference", () => {
    expect(
      calculateNextEmailAvailableAt({
        settledAt: instant("2026-03-07T18:00:00.000Z"),
        scheduleEvidence: fallback(),
      }),
    ).toEqual({
      ok: true,
      value: {
        availableAt: instant("2026-03-08T18:00:00.000Z"),
        policy: "ExplicitTwentyFourHourFallback",
      },
    });
  });

  it("exposes the scheduler through the Effect port", async () => {
    const scheduler = createEmailCourseScheduler();
    await expect(
      Effect.runPromise(
        scheduler.nextAvailableAt({
          settledAt: instant("2026-03-07T18:00:00.000Z"),
          scheduleEvidence: fallback(),
        }),
      ),
    ).resolves.toMatchObject({
      availableAt: instant("2026-03-08T18:00:00.000Z"),
    });
  });
});

function value<Value>(result: ParseResult<Value>): Value {
  if (result.ok) return result.value;
  throw new Error(result.error.reason);
}
