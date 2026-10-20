import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createQueryClient,
  PAGE_VIEW_QUERY_STALE_TIME_MS,
} from "./query-client";

// The key tRPC builds for a procedure call, so the test follows the real shape.
const keyFor = (name: string, input?: unknown) => [
  ["ability", name],
  { ...(input !== undefined && { input }), type: "query" },
];

describe("createQueryClient", () => {
  beforeEach(() => {
		vi.useFakeTimers()
	});
  afterEach(() => {
		vi.useRealTimers()
	});

  it.each(["getCurrentAbilityRules", "getSkillsCourseCtaState"])(
    "keeps %s fresh across remounts, with and without input",
    async (name) => {
      const client = createQueryClient();
      for (const input of [undefined, { lessonId: "l", moduleId: "m" }]) {
        const queryFn = vi.fn(async () => ({ n: 1 }));
        const key = keyFor(name, input);
        await client.fetchQuery({ queryKey: key, queryFn });
        // a second mount inside the window reads the cache
        await client.ensureQueryData({ queryKey: key, queryFn });
        expect(client.getQueryState(key)?.isInvalidated).toBe(false);
        expect(client.getQueryDefaults(key).staleTime).toBe(
          PAGE_VIEW_QUERY_STALE_TIME_MS,
        );
        expect(queryFn).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("goes stale after the window, so rules still refresh", async () => {
    const client = createQueryClient();
    const key = keyFor("getCurrentAbilityRules");
    const queryFn = vi.fn(async () => ({}));
    await client.fetchQuery({ queryKey: key, queryFn });
    vi.advanceTimersByTime(PAGE_VIEW_QUERY_STALE_TIME_MS + 1);
    await client.fetchQuery({ queryKey: key, queryFn });
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("invalidate still forces a refetch inside the window", async () => {
    const client = createQueryClient();
    const key = keyFor("getSkillsCourseCtaState");
    const queryFn = vi.fn(async () => ({}));
    await client.fetchQuery({ queryKey: key, queryFn });
    await client.invalidateQueries({
      queryKey: [["ability", "getSkillsCourseCtaState"]],
    });
    await client.fetchQuery({ queryKey: key, queryFn });
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("leaves other queries on the default (always stale)", () => {
    const client = createQueryClient();
    expect(
      client.getQueryDefaults(keyFor("ownsResource")).staleTime,
    ).toBeUndefined();
    expect(
      client.getQueryDefaults([["users", "getPlaybackPrefs"]]).staleTime,
    ).toBeUndefined();
  });
});
