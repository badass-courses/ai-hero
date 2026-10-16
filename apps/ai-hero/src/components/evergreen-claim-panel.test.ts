import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";
import {
  evergreenClaimMachine,
  shouldRenderClaimPanel,
  type ClaimPhase,
} from "./evergreen-claim-panel";

afterEach(() => {
  vi.unstubAllGlobals();
});
it.each([401, 404])(
  "unauthorized/disabled GET %s enters hidden pilot error, with no POST",
  async (status) => {
    const fetcher = vi.fn(
      async (_request: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ status: "verification-needed" }, { status }),
    );
    vi.stubGlobal("fetch", fetcher);
    const actor = createActor(evergreenClaimMachine, {
      input: { endpoint: "/api/evergreen/claim" },
    }).start();
    await waitFor(actor, (state) => state.matches("error"));
    actor.send({ type: "CLAIM" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
    actor.stop();
  },
);
it("an authenticated pilot without claim evidence can see the existing sign-in instructions, without automatic POST", async () => {
  const fetcher = vi.fn(async () => Response.json({ status: "unavailable" }));
  vi.stubGlobal("fetch", fetcher);
  const actor = createActor(evergreenClaimMachine, {
    input: { endpoint: "/api/evergreen/claim" },
  }).start();
  await waitFor(actor, (state) => state.matches("displaying"));
  expect(actor.getSnapshot().context.status).toBe("unavailable");
  actor.send({ type: "CLAIM" });
  expect(actor.getSnapshot().matches("displaying")).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  actor.stop();
});
const phases = ["loading", "displaying", "submitting", "error"] as const;
const statuses = [
  "unavailable",
  "verification-needed",
  "ready",
  "pending",
  "bound",
] as const;
it("pilot panel renders nothing for unavailable, even after a refresh answers unavailable", async () => {
  const fetcher = vi.fn(async () => Response.json({ status: "unavailable" }));
  vi.stubGlobal("fetch", fetcher);
  const actor = createActor(evergreenClaimMachine, {
    input: { endpoint: "/api/evergreen/claim" },
  }).start();
  const visible = () => {
    const state = actor.getSnapshot();
    return shouldRenderClaimPanel({
      pilotOnly: true,
      phase: state.value as ClaimPhase,
      status: state.context.status,
    });
  };
  expect(visible()).toBe(false);
  await waitFor(actor, (state) => state.matches("displaying"));
  expect(visible()).toBe(false);
  actor.send({ type: "REFRESH" });
  await waitFor(actor, (state) => state.matches("displaying"));
  expect(visible()).toBe(false);
  actor.stop();
});
describe("shouldRenderClaimPanel truth table", () => {
  for (const phase of phases)
    for (const status of statuses) {
      it(`non-pilot always renders (${phase}, ${status})`, () => {
        expect(shouldRenderClaimPanel({ pilotOnly: false, phase, status })).toBe(
          true,
        );
      });
      const hidden = phase === "error" || status === "unavailable";
      it(`pilot ${hidden ? "hides" : "renders"} (${phase}, ${status})`, () => {
        expect(shouldRenderClaimPanel({ pilotOnly: true, phase, status })).toBe(
          !hidden,
        );
      });
    }
});
