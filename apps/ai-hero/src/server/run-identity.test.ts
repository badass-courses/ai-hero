import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { buildRunIdentity, isNonProdExecutorOnProdDb } from './run-identity'

const runtime = { hostname: 'executor.example.test', gitSha: 'a'.repeat(40) }

describe('run identity', () => {
	it('projects only allowlisted fields; never retains credentials or query strings', () => {
		const syntheticPassword = randomUUID()
		const syntheticQuery = randomUUID()
		const url = `mysql://observer:${syntheticPassword}@db.example.test/app?token=${syntheticQuery}`
		const identity = buildRunIdentity({ DATABASE_URL: url }, runtime)
		expect(identity).toEqual({
			vercelEnv: null,
			nodeEnv: null,
			onVercel: false,
			inngest: 'cloud',
			hostname: runtime.hostname,
			gitSha: runtime.gitSha,
			dbHost: 'db.example.test',
			dbUsername: 'observer',
		})
		for (const output of [
			Object.values(identity).join(' '),
			JSON.stringify(identity),
		]) {
			expect(output.includes(syntheticPassword)).toBe(false)
			expect(output.includes(syntheticQuery)).toBe(false)
			expect(output.includes(url)).toBe(false)
		}
	})

	it('drops invalid database URLs without returning parser errors', () => {
		for (const url of [undefined, '', 'not a url', 'https://example.test']) {
			expect(buildRunIdentity({ DATABASE_URL: url }, runtime)).toMatchObject({
				dbHost: null,
				dbUsername: null,
			})
		}
	})

	it('uses Vercel SHA first and accepts client dev mode or INNGEST_DEV', () => {
		expect(
			buildRunIdentity(
				{
					VERCEL: '1',
					VERCEL_ENV: 'preview',
					NODE_ENV: 'production',
					VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40),
					INNGEST_DEV: '1',
				},
				runtime,
			),
		).toMatchObject({
			onVercel: true,
			vercelEnv: 'preview',
			nodeEnv: 'production',
			gitSha: 'b'.repeat(40),
			inngest: 'dev',
		})
		expect(buildRunIdentity({}, { ...runtime, inngestDev: true }).inngest).toBe(
			'dev',
		)
		expect(
			buildRunIdentity({}, { hostname: runtime.hostname }).gitSha,
		).toBeNull()
	})

	it.each([
		[undefined, undefined, true],
		['1', 'preview', true],
		['1', 'development', true],
		[undefined, 'production', true],
		['0', 'production', true],
		['1', 'production', false],
	])(
		'warns for prod DB unless both Vercel production markers match (%s, %s)',
		(VERCEL, VERCEL_ENV, warn) => {
			const identity = buildRunIdentity({ VERCEL, VERCEL_ENV }, runtime)
			expect(
				isNonProdExecutorOnProdDb({ ...identity, dbHost: 'region.psdb.cloud' }),
			).toBe(warn)
			expect(
				isNonProdExecutorOnProdDb({
					...identity,
					dbHost: 'psdb.cloud.example.test',
				}),
			).toBe(false)
			expect(isNonProdExecutorOnProdDb({ ...identity, dbHost: null })).toBe(
				false,
			)
		},
	)
})
