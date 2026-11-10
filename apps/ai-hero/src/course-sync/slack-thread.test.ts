import { describe, expect, it, vi } from 'vitest'
import {
	postCourseSyncThreadNotice,
	type CourseSyncSlackThread,
} from './slack-thread'
import type { CourseSyncSlackNotificationPayload } from './detection-poller'

const payload: CourseSyncSlackNotificationPayload = {
	username: 'AI Hero Course Sync',
	icon_emoji: ':repeat:',
	text: 'Held',
	attachments: [],
}

describe('course sync thread notices', () => {
	it('saves the first notice timestamp and threads reminder and live replies under it', async () => {
		let root: CourseSyncSlackThread | null = null
		const post = vi.fn(
			async (
				_options: CourseSyncSlackNotificationPayload & {
					channel: string
					thread_ts?: string
				},
			) => ({ ok: true, channel: 'C_SYNC', ts: '123.456' }),
		)
		const saveRoot = vi.fn(async (value: CourseSyncSlackThread) => {
			root = value
		})
		for (const text of ['Held', 'Reminder', 'Live'])
			await postCourseSyncThreadNotice({
				payload: { ...payload, text },
				channel: 'C_SYNC',
				root,
				post,
				saveRoot,
			})
		expect(saveRoot).toHaveBeenCalledOnce()
		expect(post.mock.calls[0]?.[0]).not.toHaveProperty('thread_ts')
		expect(post.mock.calls[1]?.[0]).toMatchObject({
			channel: 'C_SYNC',
			thread_ts: '123.456',
			text: 'Reminder',
		})
		expect(post.mock.calls[2]?.[0]).toMatchObject({
			channel: 'C_SYNC',
			thread_ts: '123.456',
			text: 'Live',
		})
	})
	it('makes live the root when no hold notice preceded the apply', async () => {
		const saveRoot = vi.fn(async () => {})
		await postCourseSyncThreadNotice({
			payload: { ...payload, text: 'Live' },
			channel: 'C_SYNC',
			root: null,
			post: async () => ({ ok: true, ts: '123.456' }),
			saveRoot,
		})
		expect(saveRoot).toHaveBeenCalledWith({ channel: 'C_SYNC', ts: '123.456' })
	})
	it.each([{ ok: false, error: 'not_in_channel' }, { ok: true }])(
		'does not save a root when Slack cannot confirm it: %j',
		async (response) => {
			const saveRoot = vi.fn(async () => {})
			await expect(
				postCourseSyncThreadNotice({
					payload,
					channel: 'C_SYNC',
					root: null,
					post: async () => response,
					saveRoot,
				}),
			).rejects.toThrow('Slack rejected')
			expect(saveRoot).not.toHaveBeenCalled()
		},
	)
})
