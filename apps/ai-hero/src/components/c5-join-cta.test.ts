import { describe, expect, it, vi } from 'vitest'

vi.mock('@/trpc/react', () => ({ api: {} }))
vi.mock('next-auth/react', () => ({ useSession: () => ({ status: 'loading' }) }))

import { c5JoinLink } from './c5-join-cta'

describe('c5JoinLink', () => {
	it('sends an owner to the cohort', () => {
		expect(c5JoinLink(true, '/s/c5-site-hero')).toEqual({
			href: '/cohorts/software-factories-for-real-engineers-xdy1m',
			label: 'Go to the cohort',
		})
	})

	it.each([false, undefined])(
		'keeps the sale link when ownership is %s',
		(owned) => {
			expect(c5JoinLink(owned, '/s/c5-site-hero')).toEqual({
				href: '/s/c5-site-hero',
				label: 'Join the cohort',
			})
		},
	)
})
