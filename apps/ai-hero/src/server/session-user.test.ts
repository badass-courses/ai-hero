import { describe, expect, it } from 'vitest'

import { userSchema } from '@coursebuilder/core/schemas'

import { parseSessionUser } from './session-user'

const base = { id: 'u_1', name: 'Learner', role: 'user' as const }

describe('parseSessionUser', () => {
	it('accepts a session user whose stored email fails the strict check', () => {
		const input = { ...base, email: 'first..last@example.com' }
		// The old path threw here, on every tRPC call.
		expect(() => userSchema.parse(input)).toThrow()

		const { user, invalidEmail } = parseSessionUser(input)
		expect(user?.id).toBe('u_1')
		expect(user?.email).toBe('first..last@example.com')
		expect(invalidEmail).toBe(true)
	})

	it('keeps a normal email and reports nothing', () => {
		const { user, invalidEmail } = parseSessionUser({ ...base, email: 'learner@example.com' })
		expect(user?.email).toBe('learner@example.com')
		expect(invalidEmail).toBe(false)
	})

	it('passes a missing session through', () => {
		expect(parseSessionUser(undefined)).toEqual({ user: undefined, invalidEmail: false })
		expect(parseSessionUser(null)).toEqual({ user: null, invalidEmail: false })
	})

	it('still rejects a session user with no id', () => {
		expect(() => parseSessionUser({ email: 'learner@example.com' })).toThrow()
	})
})
