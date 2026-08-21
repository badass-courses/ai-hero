import { describe, expect, it } from "vitest";
import { fakeDevinAdapter, validateFakeDevinResult } from "../../src/investigations/fake-devin";

describe("fake Devin boundary", () => {
  it("creates a schema-valid aggregate-only bounded result", () => {
    const result = fakeDevinAdapter.investigate({
      incidentId: "inc-fixture",
      startedAt: "2026-08-10T10:00:00.000Z",
      evidenceDigest: "evidence:aggregate:fixture",
    });
    expect(result.limits.acuMax).toBe(1);
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]?.system).toBe("axiom");
    expect(result.privacy).toEqual({
      aggregateOnly: true,
      rawLogsIncluded: false,
      customerIdentifiersIncluded: false,
    });
  });

  it("rejects private, unknown, and over-cap results", () => {
    const result = fakeDevinAdapter.investigate({
      incidentId: "inc-fixture",
      startedAt: "2026-08-10T10:00:00.000Z",
      evidenceDigest: "evidence:aggregate:fixture",
    });
    expect(() => validateFakeDevinResult({ ...result, rawLog: "private" })).toThrow();
    expect(() =>
      validateFakeDevinResult({
        ...result,
        hypotheses: [{ statement: "raw log content", status: "supported", evidenceRefs: [] }],
      }),
    ).toThrow("opaque machine values");
    expect(() =>
      validateFakeDevinResult({ ...result, limits: { ...result.limits, acuMax: 2 } }),
    ).toThrow("ACU cap");
  });
});
