import { describe, expect, it, vi } from 'vitest'

import { createOAuthAccountLinkRequest } from './oauth-link-action'
import { hashOAuthLinkSession } from '@/server/oauth-link-intent'


describe('OAuth account link request', () => {
	it('derives the target and binding from a fresh authenticated server session', async () => {
		const issueIntent = vi.fn(async () => ({
			rawToken: 'opaque-link-token',
			expiresAt: new Date('2026-08-09T12:10:00.000Z'),
		}))
		const writeIntentCookie = vi.fn()
		const request = createOAuthAccountLinkRequest({
			getAuthenticatedSession: vi.fn(async () => ({
				userId: 'session-user',
				sessionToken: 'fresh-session-token',
			})),
			findAccount: vi.fn(async () => null),
			issueIntent,
			writeIntentCookie,
		})

		await expect(request()).resolves.toEqual({ status: 'ready' })
		expect(issueIntent).toHaveBeenCalledWith({
			targetUserId: 'session-user',
			provider: 'discord',
			sessionBinding: hashOAuthLinkSession('fresh-session-token'),
		})
		expect(writeIntentCookie).toHaveBeenCalledWith({
			rawToken: 'opaque-link-token',
			expiresAt: new Date('2026-08-09T12:10:00.000Z'),
		})
	})

	it('ignores forged provider and user arguments', async () => {
		const issueIntent = vi.fn(async () => ({
			rawToken: 'opaque-link-token',
			expiresAt: new Date('2026-08-09T12:10:00.000Z'),
		}))
		const request = createOAuthAccountLinkRequest({
			getAuthenticatedSession: vi.fn(async () => ({
				userId: 'session-user',
				sessionToken: 'fresh-session-token',
			})),
			findAccount: vi.fn(async () => null),
			issueIntent,
			writeIntentCookie: vi.fn(),
		})

		await Reflect.apply(request, null, ['github', 'victim-user'])

		expect(request).toHaveLength(0)
		expect(issueIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				targetUserId: 'session-user',
				provider: 'discord',
			}),
		)
	})

	it('does not persist or write a cookie without a valid session', async () => {
		const issueIntent = vi.fn()
		const writeIntentCookie = vi.fn()
		const request = createOAuthAccountLinkRequest({
			getAuthenticatedSession: vi.fn(async () => null),
			findAccount: vi.fn(),
			issueIntent,
			writeIntentCookie,
		})

		await expect(request()).resolves.toEqual({ status: 'unauthenticated' })
		expect(issueIntent).not.toHaveBeenCalled()
		expect(writeIntentCookie).not.toHaveBeenCalled()
	})

	it('does not issue another intent for an already linked session', async () => {
		const issueIntent = vi.fn()
		const request = createOAuthAccountLinkRequest({
			getAuthenticatedSession: vi.fn(async () => ({
				userId: 'session-user',
				sessionToken: 'fresh-session-token',
			})),
			findAccount: vi.fn(async () => ({ access_token: 'active-token' })),
			issueIntent,
			writeIntentCookie: vi.fn(),
		})

		await expect(request()).resolves.toEqual({ status: 'linked' })
		expect(issueIntent).not.toHaveBeenCalled()
	})

	it('issues a renewal intent when the same-owner account has stale credentials', async () => {
		const issueIntent = vi.fn(async () => ({
			rawToken: 'renewal-token',
			expiresAt: new Date('2026-08-09T12:10:00.000Z'),
		}))
		const request = createOAuthAccountLinkRequest({
			getAuthenticatedSession: vi.fn(async () => ({
				userId: 'session-user',
				sessionToken: 'fresh-session-token',
			})),
			findAccount: vi.fn(async () => ({ access_token: null })),
			issueIntent,
			writeIntentCookie: vi.fn(),
		})

		await expect(request()).resolves.toEqual({ status: 'ready' })
		expect(issueIntent).toHaveBeenCalledOnce()
	})
})
