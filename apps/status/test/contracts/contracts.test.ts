import { describe, expect, it } from "vitest";
import { decodeDetectorEvent } from "../../src/contracts/index";
import { detectorEvent } from "../fixtures/detector-event";

describe("detector event boundary", () => {
  it("decodes the aggregate-only v1 contract", () => {
    expect(decodeDetectorEvent(detectorEvent)).toEqual(detectorEvent);
  });

  it("rejects unknown private fields at every object boundary", () => {
    expect(() =>
      decodeDetectorEvent({ ...detectorEvent, customerEmail: "private@example.test" }),
    ).toThrow();
    expect(() =>
      decodeDetectorEvent({
        ...detectorEvent,
        evidence: { ...detectorEvent.evidence, rawLog: "private" },
      }),
    ).toThrow();
  });

  it("rejects a non-aggregate privacy marker", () => {
    expect(() =>
      decodeDetectorEvent({ ...detectorEvent, privacy: "contains_customer_data" }),
    ).toThrow();
  });

  it("rejects free-form summary codes and non-integer samples", () => {
    expect(() =>
      decodeDetectorEvent({
        ...detectorEvent,
        evidence: { ...detectorEvent.evidence, summaryCode: "database failed for a customer" },
      }),
    ).toThrow();
    expect(() => decodeDetectorEvent({ ...detectorEvent, sequence: 1.5 })).toThrow();
  });
});
