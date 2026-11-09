import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CourseSyncSlackNotificationPayload } from './detection-poller'

const mocks = vi.hoisted(() => ({
	transaction: vi.fn(),
	select: vi.fn(),
	insert: vi.fn(),
	values: vi.fn(),
	fetch: vi.fn(),
}))
vi.mock('@/db', () => ({ db: { transaction: mocks.transaction } }))
vi.mock('@/env.mjs', () => ({ env: { SLACK_TOKEN: 'synthetic-test-token' } }))
import { sendThreadedCourseSyncSlackPayload } from './slack-thread-persistence'
const payload: CourseSyncSlackNotificationPayload = {
	username: 'AI Hero Course Sync',
	icon_emoji: ':repeat:',
	text: 'Live',
	attachments: [],
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubGlobal('fetch', mocks.fetch)
	mocks.transaction.mockImplementation(async (callback) =>
		callback({ select: mocks.select, insert: mocks.insert }),
	)
	mocks.insert.mockReturnValue({ values: mocks.values })
	mocks.fetch.mockResolvedValue({
		ok: true,
		json: async () => ({ ok: true, channel: 'C_SYNC', ts: '123.456' }),
	})
})
afterEach(() => {
	vi.unstubAllGlobals()
})
function queries(root: unknown) {
	const run = {
		runId: 'run-test',
		bindingId: 'binding-test',
		courseVersionId: 'version-test',
	}
	const lock = vi.fn(async () => [run])
	mocks.select.mockReturnValueOnce({
		from: () => ({ where: () => ({ for: lock }) }),
	})
	mocks.select.mockReturnValueOnce({
		from: () => ({
			where: async () => (root ? [{ metadata: { slackThread: root } }] : []),
		}),
	})
	return lock
}

describe('durable Slack thread adapter', () => {
	it('locks the run and stores the returned first-notice timestamp', async () => {
		const lock = queries(null)
		await sendThreadedCourseSyncSlackPayload(payload, 'run-test', 'C_SYNC')
		expect(lock).toHaveBeenCalledWith('update')
		expect(mocks.values).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'cspl_slack_thread_run-test',
				controlPlaneRunId: 'run-test',
				metadata: { slackThread: { channel: 'C_SYNC', ts: '123.456' } },
			}),
		)
		const options = JSON.parse(mocks.fetch.mock.calls[0]![1].body)
		expect(options).not.toHaveProperty('thread_ts')
	})
	it('posts into the saved channel and thread, not a new root', async () => {
		queries({ channel: 'C_ORIGINAL', ts: '100.200' })
		await sendThreadedCourseSyncSlackPayload(
			payload,
			'run-test',
			'C_NEW_CONFIG',
		)
		expect(JSON.parse(mocks.fetch.mock.calls[0]![1].body)).toMatchObject({
			channel: 'C_ORIGINAL',
			thread_ts: '100.200',
		})
		expect(mocks.insert).not.toHaveBeenCalled()
	})
	it('refuses an unconfirmed notice without saving a root', async () => {
		queries(null)
		mocks.fetch.mockResolvedValue({
			ok: true,
			json: async () => ({ ok: false, error: 'not_in_channel' }),
		})
		await expect(
			sendThreadedCourseSyncSlackPayload(payload, 'run-test', 'C_SYNC'),
		).rejects.toThrow('not_in_channel')
		expect(mocks.insert).not.toHaveBeenCalled()
	})
})
