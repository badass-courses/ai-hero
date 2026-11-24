// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import Footer from './footer'

const { useSession } = vi.hoisted(() => ({ useSession: vi.fn() }))

vi.mock('next-auth/react', () => ({ useSession }))
vi.mock('next/navigation', () => ({ usePathname: () => '/' }))
vi.mock('next/link', () => ({
	default: ({
		href,
		prefetch,
		children,
	}: {
		href: string
		prefetch?: boolean
		children: React.ReactNode
	}) => (
		<a href={href} data-prefetch={prefetch}>
			{children}
		</a>
	),
}))
vi.mock('@/ability', () => ({ createAppAbility: () => ({ can: () => true }) }))
vi.mock('@/trpc/react', () => ({
	api: { ability: { getCurrentAbilityRules: { useQuery: () => ({}) } } },
}))
vi.mock('@/utils/analytics', () => ({ track: vi.fn() }))
vi.mock('@coursebuilder/ui/feedback-widget/feedback-context', () => ({
	useFeedback: () => ({ setIsFeedbackDialogOpen: vi.fn() }),
}))
vi.mock('./theme-toggle', () => ({ ThemeToggle: () => null }))
vi.mock('./timed-promo-bar-switch', () => ({ useFeaturedPromo: () => null }))

let root: ReturnType<typeof createRoot> | undefined

afterEach(async () => {
	await act(async () => root?.unmount())
	root = undefined
	vi.unstubAllGlobals()
})

async function renderFooter() {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	const container = document.createElement('div')
	root = createRoot(container)
	await act(async () => root?.render(<Footer />))
	return container
}

function expectNoPrefetch(link: Element | null) {
	expect(link?.getAttribute('data-prefetch')).toBe('false')
}

describe('footer link prefetch', () => {
	it('skips cohort renders, login, the signup funnel and markdown but keeps static page defaults', async () => {
		useSession.mockReturnValue({ data: null, status: 'unauthenticated' })
		const footer = await renderFooter()

		const cohorts = footer.querySelectorAll('a[href^="/cohorts/"]')
		expect(cohorts.length).toBeGreaterThan(0)
		cohorts.forEach(expectNoPrefetch)
		for (const href of ['/login', '/skills/subscribe', '/skills.md']) {
			expectNoPrefetch(footer.querySelector(`a[href="${href}"]`))
		}
		for (const href of ['/skills', '/workshops/ai-coding-crash-course']) {
			expect(
				footer.querySelector(`a[href="${href}"]`)?.hasAttribute('data-prefetch'),
			).toBe(false)
		}
	})

	it('does not prefetch the signed-in account pages', async () => {
		useSession.mockReturnValue({
			data: { user: { email: 'learner@example.test' } },
			status: 'authenticated',
		})
		const footer = await renderFooter()

		expectNoPrefetch(footer.querySelector('a[href="/profile#my-courses"]'))
		expectNoPrefetch(footer.querySelector('a[href="/invoices"]'))
	})
})
