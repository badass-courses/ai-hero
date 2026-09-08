import { describe, it, expect, vi } from "vitest";
import {
  runBoundedBridgeEvent,
  bridgeRuntimeCommandSchema,
} from "./evergreen-bridge-runtime";
import { inspectEvergreenBridge } from "@/scripts/evergreen-bridge-operator";

vi.mock("@/db", () => {
  throw new Error("Operator inspection must not instantiate DB");
});
vi.mock("@/server/redis-client", () => {
  throw new Error("Operator inspection must not instantiate Redis");
});
vi.mock("@/coursebuilder/email-list-provider", () => {
  throw new Error("Operator inspection must not instantiate provider");
});

describe("explicit bridge operator and durable boundary", () => {
  it("reads disabled source configuration without acquiring any capabilities", () => {
    expect(inspectEvergreenBridge()).toMatchObject({
      type: "Disabled",
      registration: "NotRegistered",
      configuredRevisionCount: 0,
      newsletterOwnership: "ExternalContinuity",
      terminalHandoff: "HeldNotApplied",
    });
  });
  it.each([
    null,
    {},
    { type: "unknown" },
    { type: "scan", request: { generation: "a", lane: "source", limit: 1000 } },
    { type: "couponUncertain", generation: "a", input: { now: "forged" } },
    {
      type: "messageRecorded",
      generation: "a",
      input: {
        afterByScope: {
          scope: {
            leaseExpiresAt: "2026-09-08T00:00:00.000Z",
            idempotencyKey: "a",
            status: "Claimed",
          },
        },
      },
    },
  ])(
    "refuses malformed/authority-bearing command before resolving runtime %#",
    async (input) => {
      const resolve = vi.fn(async () => null);
      expect(await runBoundedBridgeEvent(resolve, input)).toMatchObject({
        type: "Unavailable",
        reason: "InvalidCommand",
      });
      expect(resolve).not.toHaveBeenCalled();
    },
  );
  it("has no default runtime or automatic activation", async () => {
    expect(
      await runBoundedBridgeEvent(async () => null, {
        type: "scan",
        request: { generation: "a", lane: "source" },
      }),
    ).toEqual({ type: "Disabled" });
  });
  it("preserves actual recovery cursor vocabularies, never accepts scan time as lease position", () => {
    expect(
      bridgeRuntimeCommandSchema.safeParse({
        type: "couponUncertain",
        generation: "a",
        input: { after: { at: "2026-09-08T00:00:00.000Z", id: "a" } },
      }).success,
    ).toBe(false);
    expect(
      bridgeRuntimeCommandSchema.safeParse({
        type: "claimSource",
        generation: "a",
        input: { after: "claim-event-id" },
      }).success,
    ).toBe(true);
  });
});
