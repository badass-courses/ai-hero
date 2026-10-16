import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
	ACK_EXPIRED_LOG_SIGNAL,
	createAckExpiredProcessLogger,
} from './contact-sync-profile-ack-expired-log'
import type { AckEvidenceExpired } from './contact-sync-profile-ack-schema'

const expired: AckEvidenceExpired = {
	_tag: 'AckEvidenceExpired',
	v: 1,
	target: 'production',
	contactId: 'synthetic-private-contact',
	profileVersion: 3,
	requestId: '1'.repeat(64),
}
describe('bounded process-local expired ACK logging (not distributed)', () => {
	it('suppresses a second concurrent call for the same hashed contact/version, including another monthly request', async () => {
		const log = createAckExpiredProcessLogger()
		const logger = { warn: vi.fn(async () => undefined) }
		await Promise.all([
			log(expired, logger),
			log({ ...expired, requestId: '2'.repeat(64) }, logger),
		])
		expect(logger.warn).toHaveBeenCalledTimes(1)
		expect(logger.warn).toHaveBeenCalledWith(
			ACK_EXPIRED_LOG_SIGNAL,
			expect.objectContaining({
				profileVersion: 3,
				suppression: 'bounded-process-local-lru',
				contactVersionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			}),
		)
		expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
			expired.contactId,
		)
		expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
			expired.requestId,
		)
	})
	it('has no retry or failure when the logger is missing, throws or rejects', async () => {
		const log = createAckExpiredProcessLogger()
		await expect(log(expired)).resolves.toBeUndefined()
		const logger = {
			warn: vi.fn(() => {
				throw new Error('synthetic unavailable sink')
			}),
		}
		await expect(log(expired, logger)).resolves.toBeUndefined()
		await log(expired, logger)
		expect(logger.warn).toHaveBeenCalledTimes(1)
		await expect(
			log(
				{ ...expired, profileVersion: 4 },
				{
					warn: async () => {
						throw new Error('synthetic rejected sink')
					},
				},
			),
		).resolves.toBeUndefined()
	})
	it('bounds memory, refreshes LRU membership and honestly permits re-log after eviction', async () => {
		const log = createAckExpiredProcessLogger(2)
		const logger = { warn: vi.fn() }
		await log(expired, logger)
		await log({ ...expired, profileVersion: 4 }, logger)
		await log(expired, logger) // keep v3; v4 is oldest
		await log({ ...expired, profileVersion: 5 }, logger)
		await log(expired, logger)
		expect(logger.warn).toHaveBeenCalledTimes(3)
		await log({ ...expired, profileVersion: 4 }, logger)
		expect(logger.warn).toHaveBeenCalledTimes(4)
	})
	it('a real fresh Node process logs once, independently of another process', () => {
		// Node24 is the CI/runtime baseline; its native type stripping loads
		// this tiny module (only node:crypto plus a type-only schema import).
		const moduleUrl = pathToFileURL(
			`${process.cwd()}/src/lib/subscriber-marketing/contact-sync-profile-ack-expired-log.ts`,
		).href
		const script = `import { logAckEvidenceExpiredOncePerProcess as log } from ${JSON.stringify(moduleUrl)}; let n=0; const logger={warn:()=>{n++}}; const result=${JSON.stringify(expired)}; await log(result,logger); await log(result,logger); process.stdout.write(String(n));`
		for (let run = 0; run < 2; run++)
			expect(
				execFileSync(
					process.execPath,
					['--input-type=module', '--eval', script],
					{ encoding: 'utf8', timeout: 10000 },
				),
			).toBe('1')
	})
})
