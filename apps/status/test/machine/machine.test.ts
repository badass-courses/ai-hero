import { describe, expect, it } from "vitest";
import { transitionIncident } from "../../src/incident/machine";

describe("incident machine", () => {
  it("allows the charter transitions", () => {
    expect(transitionIncident("healthy", { type: "FAILURE" }).state).toBe("investigating");
    expect(
      transitionIncident("investigating", { type: "EVALUATE", classification: "degraded" }).state,
    ).toBe("degraded");
    expect(
      transitionIncident("investigating", { type: "EVALUATE", classification: "outage" }).state,
    ).toBe("outage");
    expect(transitionIncident("investigating", { type: "WINDOW_CLOSED" }).state).toBe("healthy");
    expect(
      transitionIncident("degraded", { type: "EVALUATE", classification: "outage" }).state,
    ).toBe("outage");
    expect(transitionIncident("degraded", { type: "RECOVERY_READY" }).state).toBe("recovering");
    expect(transitionIncident("outage", { type: "RECOVERY_READY" }).state).toBe("recovering");
    expect(
      transitionIncident("recovering", { type: "EVALUATE", classification: "degraded" }).state,
    ).toBe("degraded");
    expect(
      transitionIncident("recovering", { type: "EVALUATE", classification: "outage" }).state,
    ).toBe("outage");
    expect(transitionIncident("recovering", { type: "RESOLUTION_READY" }).state).toBe("resolved");
  });

  it("keeps illegal transitions inert and resolved terminal", () => {
    expect(transitionIncident("outage", { type: "RESOLUTION_READY" })).toEqual({
      state: "outage",
      changed: false,
    });
    expect(transitionIncident("degraded", { type: "RESOLUTION_READY" }).state).toBe("degraded");
    expect(transitionIncident("resolved", { type: "FAILURE" }).state).toBe("resolved");
  });
});
