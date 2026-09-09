import { afterEach, expect, it, vi } from "vitest";
import { createActor, waitFor } from "xstate";
import { evergreenClaimMachine } from "./evergreen-claim-panel";

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
