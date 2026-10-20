import { QueryClient } from "@tanstack/react-query";

/**
 * How long the per-page-view reads stay fresh in the browser.
 *
 * `new QueryClient()` has a staleTime of 0, so every component that mounts
 * `ability.getCurrentAbilityRules` or `ability.getSkillsCourseCtaState`
 * (nav, user menu, footer, mobile menu, page-level bars) refetches on mount
 * and on window focus, which turns each client-side navigation into a fresh
 * server round trip for an answer that has not changed.
 *
 * These results only DRAW UI. Access is enforced on the server by the
 * procedures that serve the content, so a stale client answer can show a
 * button for a minute or two longer; it cannot grant or withhold access.
 * Explicit `invalidate()` and `setData()` calls (signup, subscribe) ignore
 * staleTime, so flows that change the answer still refresh it at once. A
 * full page load, which login and checkout return use, starts a new client.
 */
export const PAGE_VIEW_QUERY_STALE_TIME_MS = 2 * 60 * 1000;

/** tRPC query-key prefixes; inputs (lessonId, moduleId) match by prefix. */
export const PAGE_VIEW_QUERY_KEYS = [
  [["ability", "getCurrentAbilityRules"]],
  [["ability", "getSkillsCourseCtaState"]],
] as const;

export function createQueryClient() {
  const queryClient = new QueryClient();
  for (const queryKey of PAGE_VIEW_QUERY_KEYS) {
    queryClient.setQueryDefaults(queryKey, {
      staleTime: PAGE_VIEW_QUERY_STALE_TIME_MS,
    });
  }
  return queryClient;
}
