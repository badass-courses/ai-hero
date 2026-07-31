import { getHubSidebarIa } from '@/lib/hub-sidebar-ia'
import { createTRPCRouter, publicProcedure } from '@/trpc/api/trpc'

/**
 * Navigation IA for client surfaces that can't compile the sidebar MDX
 * themselves. `getMobileNav` returns the resolved hub-sidebar sections (same
 * single MDX source as the desktop sidebar). Public + identical for every
 * visitor, and `getHubSidebarIa` is `unstable_cache`d, so the mobile menu's
 * lazy fetch is a shared cache hit.
 */
export const navigationRouter = createTRPCRouter({
	getMobileNav: publicProcedure.query(async () => getHubSidebarIa()),
})
