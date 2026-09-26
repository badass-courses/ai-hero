import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

const reader = vi.hoisted(() => vi.fn())
vi.mock('@/env.mjs', () => ({
	env: {
		NEXTAUTH_SECRET: 'test-signing-secret',
		DROPBOX_SYNC_SHARED_LINK: 'https://www.dropbox.com/scl/fo/test',
		DROPBOX_REFRESH_TOKEN: 'test-refresh-token',
	},
}))
vi.mock('@/lib/dropbox-course-sync', () => ({
	getDropboxSyncConfig: () => ({
		config: {
			source: {
				kind: 'shared-link',
				sharedLink: 'https://www.dropbox.com/scl/fo/test',
			},
		},
		missingConfig: [],
	}),
	createDropboxSharedLinkAssetReader: () => ({ read: reader }),
}))

import { createDropboxMuxProxyUrl } from '@/course-sync/dropbox-mux-source'
import { AI_HERO_COURSE_SYNC_BINDING } from '@/course-sync/types'
import { GET } from './route'

const bindingId = AI_HERO_COURSE_SYNC_BINDING.bindingId
const signedUrl = () =>
	createDropboxMuxProxyUrl({
		baseUrl: 'https://www.aihero.dev',
		bindingId,
		relativePath: 'lesson/video.mp4',
		expiresAt: Date.now() + 60_000,
		signingSecret: 'test-signing-secret',
	})

describe('course-sync Dropbox proxy', () => {
	it('accepts a binding-scoped token and streams only its bound asset', async () => {
		reader.mockResolvedValue({
			stream: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array([1]))
					controller.close()
				},
			}),
			bytes: 1,
			providerRevision: 'r1',
		})
		const response = await GET(new Request(signedUrl()))
		expect(response.status).toBe(200)
		expect(response.headers.get('X-Course-Sync-Dropbox-Rev')).toBe('r1')
		expect(reader).toHaveBeenCalledWith('lesson/video.mp4')
	})

	it('rejects missing binding, unknown binding, cross-binding and legacy signatures before Dropbox reads', async () => {
		reader.mockClear()
		const missing = new URL(signedUrl())
		missing.searchParams.delete('binding')
		expect((await GET(new Request(missing))).status).toBe(400)
		const unknown = new URL(signedUrl())
		unknown.searchParams.set('binding', 'unknown-binding')
		expect((await GET(new Request(unknown))).status).toBe(404)
		const wrong = new URL(signedUrl())
		wrong.searchParams.set('signature', 'wrong')
		expect((await GET(new Request(wrong))).status).toBe(403)
		const legacy = new URL(signedUrl())
		legacy.searchParams.set(
			'signature',
			createHmac('sha256', 'test-signing-secret')
				.update(`${legacy.searchParams.get('expires')}:lesson/video.mp4`)
				.digest('base64url'),
		)
		expect((await GET(new Request(legacy))).status).toBe(403)
		expect(reader).not.toHaveBeenCalled()
	})
})
