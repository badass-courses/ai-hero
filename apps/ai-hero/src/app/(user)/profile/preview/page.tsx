import LayoutClient from '@/components/layout-client'
import type { LibraryEntry } from '@/lib/library-query'

import { LibrarySection } from '../_components/library-section'

/**
 * THROWAWAY — delete this route before merging. `git revert` the commit that
 * added it.
 *
 * It renders `LibrarySection` against hard-coded entries so the page can be
 * looked at without a purchaser's session. An admin account cannot stand in
 * for one: admin ability rules unlock everything, so gated and partial states
 * never appear. The numbers below are the real shape of the "AI Coding for
 * Real Engineers" cohort (8 workshops, 68 lessons) with invented progress —
 * no real person's data is used or displayed.
 */
const PREVIEW_ENTRIES: LibraryEntry[] = [
	{
		key: 'preview-cohort',
		title: 'AI Coding for Real Engineers',
		contextLabel: 'Getting To Know Claude Code',
		href: '/cohorts/ai-coding-for-real-engineers-m0k0w',
		cta: {
			label: 'Continue: Permissions',
			href: '/workshops/claude-code~p9j8f/permissions~pwt8r',
		},
		completedLessons: 14,
		totalLessons: 68,
		percent: 21,
		status: 'in-progress',
		purchasedAt: new Date('2026-05-18T00:00:00.000Z'),
	},
	{
		key: 'preview-workshop-unstarted',
		title: 'Day 5 AFK Agents',
		contextLabel: null,
		href: '/workshops/afk-agents~h0fsr',
		cta: {
			label: 'Start: What Is An AFK Agent',
			href: '/workshops/afk-agents~h0fsr/afk-agents~t0swg',
		},
		completedLessons: 0,
		totalLessons: 9,
		percent: 0,
		status: 'not-started',
		purchasedAt: new Date('2026-06-08T00:00:00.000Z'),
	},
	{
		key: 'preview-workshop-complete',
		title: 'Before We Start',
		contextLabel: 'AI Coding for Real Engineers',
		href: '/workshops/before-start~ubuuc',
		cta: { label: 'Review', href: '/workshops/before-start~ubuuc' },
		completedLessons: 8,
		totalLessons: 8,
		percent: 100,
		status: 'complete',
		purchasedAt: new Date('2026-05-18T00:00:00.000Z'),
	},
	{
		key: 'preview-plain',
		title: 'Total TypeScript',
		contextLabel: null,
		href: '/workshops',
		cta: { label: 'Open', href: '/workshops' },
		completedLessons: 0,
		totalLessons: 0,
		percent: 0,
		status: 'not-started',
		purchasedAt: new Date('2025-11-02T00:00:00.000Z'),
	},
]

export default function ProfileLibraryPreviewPage() {
	return (
		<LayoutClient withContainer>
			<div className="max-w-(--breakpoint-lg) mx-auto flex min-h-[calc(100vh-var(--nav-height))] w-full flex-col items-start gap-8 px-5 py-20 sm:gap-10 sm:py-16 md:flex-row lg:gap-16">
				<header className="w-full md:max-w-[230px]">
					<h1 className="text-center text-xl font-bold md:text-left">
						Your Profile
					</h1>
					<p className="text-muted-foreground mt-2 text-center text-xs md:text-left">
						Preview with fixture data — not a real account.
					</p>
				</header>
				<main className="flex w-full flex-col space-y-10 md:max-w-xl">
					<LibrarySection entries={PREVIEW_ENTRIES} />
					<section className="border-input rounded-[6px] border border-dashed p-4">
						<p className="text-muted-foreground text-sm">
							The rest of the profile (GitHub / Discord connections, name and
							email) is unchanged and omitted here.
						</p>
					</section>
				</main>
			</div>
		</LayoutClient>
	)
}
