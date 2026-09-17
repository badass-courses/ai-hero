import { describe, expect, it } from "vitest";

import { transitionEmailCoursePhase } from "./phase-machine";

describe("email course phase machine", () => {
  it("moves signup through due delivery and retry states", () => {
    expect(
      transitionEmailCoursePhase({
        from: "not_started",
        event: { type: "SIGNUP_PLANNED" },
      }),
    ).toEqual({ ok: true, phase: "active.awaitingDelivery" });
    expect(
      transitionEmailCoursePhase({
        from: "active.awaitingDelivery",
        event: { type: "DELIVERY_SETTLED_WITH_NEXT" },
      }),
    ).toEqual({ ok: true, phase: "active.awaitingNextDue" });
    expect(
      transitionEmailCoursePhase({
        from: "active.awaitingNextDue",
        event: { type: "ANSWER_ACCELERATED" },
      }),
    ).toEqual({ ok: true, phase: "active.awaitingDelivery" });
    expect(
      transitionEmailCoursePhase({
        from: "active.awaitingDelivery",
        event: { type: "DELIVERY_RETRY_SCHEDULED" },
      }),
    ).toEqual({ ok: true, phase: "active.retryWait" });
  });

  it("rejects events that do not belong to the current phase", () => {
    expect(
      transitionEmailCoursePhase({
        from: "active.awaitingNextDue",
        event: { type: "RETRY_DUE" },
      }),
    ).toEqual({
      ok: false,
      from: "active.awaitingNextDue",
      event: "RETRY_DUE",
    });
  });

  it("makes sequence exhaustion final", () => {
    const exhausted = transitionEmailCoursePhase({
      from: "active.awaitingDelivery",
      event: { type: "SEQUENCE_EXHAUSTED" },
    });
    expect(exhausted).toEqual({ ok: true, phase: "sequenceExhausted" });
    expect(
      transitionEmailCoursePhase({
        from: "sequenceExhausted",
        event: { type: "STOP" },
      }),
    ).toEqual({
      ok: false,
      from: "sequenceExhausted",
      event: "STOP",
    });
  });
});
