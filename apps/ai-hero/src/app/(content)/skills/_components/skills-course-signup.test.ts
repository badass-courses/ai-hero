import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { completeSkillsCourseSignup } from './skills-course-signup'
import { SKILLS_HOSTED_RESUBSCRIBE_URL } from './skills-newsletter-config'

const subscriber = (state: string) =>
	({
		id: 123,
		state,
		email_address: 'reader@example.com',
	}) as any

describe('completeSkillsCourseSignup', () => {
	const assign = vi.fn()
	const push = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubGlobal('window', { location: { assign } })
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('sends an active subscriber to the course variant of /confirm', () => {
		const onEnrolled = vi.fn()
		completeSkillsCourseSignup(subscriber('active'), { push }, onEnrolled)

		expect(onEnrolled).toHaveBeenCalledOnce()
		const url = push.mock.calls[0]?.[0] as string
		// `flow=course` is the whole point: without it the page promises a
		// confirmation-link email the course flow never sends.
		expect(url).toContain('/confirm?')
		expect(url).toContain('flow=course')
	})

	it('sends an inactive subscriber to the hosted resubscribe flow', () => {
		const onEnrolled = vi.fn()
		completeSkillsCourseSignup(subscriber('inactive'), { push }, onEnrolled)

		expect(assign).toHaveBeenCalledWith(SKILLS_HOSTED_RESUBSCRIBE_URL)
		expect(push).not.toHaveBeenCalled()
		expect(onEnrolled).not.toHaveBeenCalled()
	})

	it('does nothing without a subscriber', () => {
		completeSkillsCourseSignup(undefined, { push })

		expect(push).not.toHaveBeenCalled()
		expect(assign).not.toHaveBeenCalled()
	})
})
