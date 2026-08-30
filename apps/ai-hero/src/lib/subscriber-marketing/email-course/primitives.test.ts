import { describe, expect, it } from "vitest";

import {
  courseIntentKey,
  deriveCourseRunId,
  parseContactId,
  parseContentResourceId,
  parseCourseId,
  parseCoursePathId,
  parseCourseRunId,
  parseEventId,
  parseIanaTimeZone,
  parseIsoInstant,
} from "./primitives";

describe("email course primitives", () => {
  it("derives stable run and intent identities", () => {
    const courseId = value(parseCourseId("skills-workflow"));
    const entryEventId = value(parseEventId("event-entry"));
    const runId = deriveCourseRunId({ courseId, entryEventId });
    const contactId = value(parseContactId("contact-1"));
    const pathId = value(parseCoursePathId("ai-hero-skills-workflow"));
    const contentResourceId = value(
      parseContentResourceId("ai-hero-skills-workflow.email-0"),
    );

    expect(runId).toBe("email-course:skills-workflow:event-entry");
    expect(courseIntentKey({ contactId, pathId, contentResourceId })).toBe(
      "contact:contact-1:value-path:ai-hero-skills-workflow:email:ai-hero-skills-workflow.email-0",
    );
  });

  it("rejects unscoped run ids and implicit local timestamps", () => {
    expect(parseCourseRunId("run-1")).toMatchObject({
      ok: false,
      error: { reason: "invalid-course-run-id" },
    });
    expect(parseIsoInstant("2026-08-30 09:00:00")).toMatchObject({
      ok: false,
      error: { reason: "invalid-iso-instant" },
    });
  });

  it("accepts explicit instants and real IANA zones", () => {
    expect(parseIsoInstant("2026-08-30T09:00:00-07:00")).toEqual({
      ok: true,
      value: "2026-08-30T16:00:00.000Z",
    });
    expect(parseIanaTimeZone("America/Los_Angeles")).toEqual({
      ok: true,
      value: "America/Los_Angeles",
    });
  });
});

function value<Value>(result: {
  readonly ok: boolean;
  readonly value?: Value;
}): Value {
  if (!result.ok || result.value === undefined) throw new Error("parse failed");
  return result.value;
}
