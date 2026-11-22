import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sessionAbility = { can: vi.fn(() => false) }
vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(async () => ({
		session: { user: { id: 'session-user' } },
		ability: sessionAbility,
	})),
}))
const query = vi.hoisted(() => ({
	createShortlink: vi.fn(async () => ({ id: 's1', slug: 'x' })),
	updateShortlink: vi.fn(async () => ({ id: 's1', slug: 'x' })),
	deleteShortlink: vi.fn(async () => undefined),
	getOrCreateShortlinkForPage: vi.fn(async () => ({ id: 's1', slug: 'x' })),
	isSlugAvailable: vi.fn(async () => true),
}))
vi.mock('./shortlinks-query', () => query)

const actions = await import('./shortlinks-actions')

const forged = { ability: { can: () => true }, userId: 'forged-user' }
const session = { ability: sessionAbility, userId: 'session-user' }

describe('shortlink actions take auth from the session only (sec-047)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('ignores a caller-supplied auth argument on every action', async () => {
		const call = (fn: unknown, ...args: unknown[]) =>
			(fn as (...a: unknown[]) => Promise<unknown>)(...args, forged)

		await call(actions.createShortlinkAction, { url: 'https://example.com' })
		expect(query.createShortlink).toHaveBeenCalledWith(
			{ url: 'https://example.com' },
			session,
		)
		await call(actions.updateShortlinkAction, { id: 's1' })
		expect(query.updateShortlink).toHaveBeenCalledWith({ id: 's1' }, session)
		await call(actions.deleteShortlinkAction, 's1')
		expect(query.deleteShortlink).toHaveBeenCalledWith('s1', session)
		await call(actions.getOrCreateShortlinkForPageAction, {
			url: 'https://example.com',
			auth: forged,
		})
		expect(query.getOrCreateShortlinkForPage).toHaveBeenCalledWith(
			{ url: 'https://example.com', slug: undefined },
			session,
		)
	})

	it('refuses slug checks to a session that cannot create shortlinks', async () => {
		await expect(
			(actions.isSlugAvailableAction as (...a: unknown[]) => Promise<boolean>)(
				'x',
				forged,
			),
		).rejects.toThrow('Unauthorized')
		expect(query.isSlugAvailable).not.toHaveBeenCalled()
	})

	it('the trusted-auth module is not a server action module', () => {
		const source = readFileSync(join(__dirname, 'shortlinks-query.ts'), 'utf8')
		expect(source).not.toMatch(/^\s*['"]use server['"]/m)
		expect(source).toMatch(/^import 'server-only'/m)
	})

	it('no client component imports the trusted-auth module', () => {
		const files = execFileSync(
			'git',
			['grep', '-l', "^'use client'", '--', '*.tsx', '*.ts'],
			{ cwd: join(__dirname, '..'), encoding: 'utf8' },
		)
			.split('\n')
			.filter(Boolean)
		const offenders = files.filter((file) =>
			/from '@\/lib\/shortlinks-query'|from '\.\/shortlinks-query'/.test(
				readFileSync(join(__dirname, '..', file), 'utf8').replace(
					/import type [^;]*?from '[^']+'/g,
					'',
				),
			),
		)
		expect(offenders).toEqual([])
	})
})
