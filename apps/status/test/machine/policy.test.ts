import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  evaluateRecovery,
  findSuppression,
  TRACER_POLICY,
} from "../../src/incident/policy";
import type { DetectorEvent } from "../../src/contracts/index";
import { detectorEvent } from "../fixtures/detector-event";

const event = (overrides: Partial<DetectorEvent>): DetectorEvent => ({
  ...detectorEvent,
  ...overrides,
  signal: { ...detectorEvent.signal, ...overrides.signal },
  evidence: { ...detectorEvent.evidence, ...overrides.evidence },
});

describe("tracer policy", () => {
  it("applies 2-of-3 degraded and independent-family outage thresholds", () => {
    const events = [
      event({ eventId: "1", observedAt: "2026-08-10T10:00:00.000Z" }),
      event({
        eventId: "2",
        detectorId: "database-probe-b",
        observedAt: "2026-08-10T10:02:00.000Z",
      }),
    ];
    expect(classifyFailure(events, "2026-08-10T10:02:00.000Z")).toBe("degraded");
    expect(
      classifyFailure(
        [
          ...events,
          event({
            eventId: "3",
            detectorId: "database-synthetic",
            detectorKind: "synthetic",
            observedAt: "2026-08-10T10:03:00.000Z",
          }),
        ],
        "2026-08-10T10:03:00.000Z",
      ),
    ).toBe("outage");
  });

  it("does not treat one detector claiming two families as independent", () => {
    const events = [
      event({ eventId: "same-1", detectorId: "shared-detector" }),
      event({
        eventId: "same-2",
        detectorId: "shared-detector",
        detectorKind: "synthetic",
        observedAt: "2026-08-10T10:01:00.000Z",
      }),
    ];
    expect(classifyFailure(events, "2026-08-10T10:01:00.000Z")).toBe("degraded");
  });

  it("never treats unknown as pass", () => {
    expect(
      classifyFailure(
        [
          event({ eventId: "1" }),
          event({
            eventId: "2",
            observedAt: "2026-08-10T10:01:00.000Z",
            signal: { ...detectorEvent.signal, state: "unknown" },
          }),
        ],
        "2026-08-10T10:01:00.000Z",
      ),
    ).toBe("none");
  });

  it("matches only the exact unexpired launch suppression", () => {
    const expected = event({
      detectorId: "ai-hero-skills-newsletter-path-entry-v2",
      target: "learner_flow",
      observedAt: "2026-08-20T12:00:00.000Z",
      signal: {
        ...detectorEvent.signal,
        code: "subscribe_to_shadow_newsletter_sequence_paused",
      },
    });
    expect(findSuppression(expected)?.id).toBe("launch-shadow-newsletter-paused-v1");
    expect(findSuppression({ ...expected, target: "database" })).toBeUndefined();
    expect(
      findSuppression({ ...expected, observedAt: "2026-08-26T00:00:00.000Z" }),
    ).toBeUndefined();
    expect(TRACER_POLICY.suppressions.every((rule) => !rule.detectorId.includes("*"))).toBe(true);
  });

  it("requires every opening family and an independent core pass for resolution", () => {
    const passes = [0, 1, 5].flatMap((minute) => [
      event({
        eventId: `fp-${minute}`,
        observedAt: `2026-08-10T10:0${minute}:00.000Z`,
        signal: { ...detectorEvent.signal, state: "pass", severity: "info" },
      }),
      event({
        eventId: `syn-${minute}`,
        detectorId: "database-synthetic",
        detectorKind: "synthetic",
        observedAt: `2026-08-10T10:0${minute}:00.000Z`,
        signal: { ...detectorEvent.signal, state: "pass", severity: "info" },
      }),
    ]);
    expect(
      evaluateRecovery(
        passes.slice(0, 4),
        ["first_party_probe", "synthetic"],
        ["database-probe-a", "database-synthetic"],
      ),
    ).toEqual({ entry: true, resolved: false });
    expect(
      evaluateRecovery(
        passes,
        ["first_party_probe", "synthetic"],
        ["database-probe-a", "database-synthetic"],
      ),
    ).toEqual({ entry: true, resolved: false });
    const independent = event({
      eventId: "provider-pass",
      detectorId: "database-provider-check",
      detectorKind: "provider_status",
      observedAt: "2026-08-10T10:05:30.000Z",
      signal: { ...detectorEvent.signal, state: "pass", severity: "info" },
    });
    expect(
      evaluateRecovery(
        [...passes, independent],
        ["first_party_probe", "synthetic"],
        ["database-probe-a", "database-synthetic"],
      ),
    ).toEqual({ entry: true, resolved: true });
  });
});
