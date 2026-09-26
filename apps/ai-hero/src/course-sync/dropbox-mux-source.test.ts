import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { AI_HERO_COURSE_SYNC_BINDING, type CourseSyncBinding } from './types'
import {
	createDropboxMuxSourceResolver,
	createBindingScopedMuxSourceResolver,
	verifyDropboxMuxProxyToken,
} from './dropbox-mux-source'

const config = {
	appKey: 'app-key',
	appSecret: 'app-secret',
	redirectUri: 'https://example.com/callback',
	source: {
		kind: 'shared-link' as const,
		sharedLink: 'https://www.dropbox.com/scl/fo/folder?rlkey=test&dl=0',
	},
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function metadata() {
	return {
		'.tag': 'file',
		path_lower: '/course/video.mp4',
		rev: 'dropbox-rev-1',
		content_hash: 'content-hash-1',
		size: 123,
	}
}

function resolver(fetchImpl: typeof fetch) {
	return createDropboxMuxSourceResolver({
		config,
		refreshToken: 'refresh-token',
		baseUrl: 'https://www.aihero.dev',
		signingSecret: 'signing-secret',
		fetchImpl,
		clock: () => 1_000,
	})
}

describe('Dropbox Mux source resolver', () => {
	it('uses a temporary link before other strategies', async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			const value = String(url)
			if (value.endsWith('/oauth2/token')) return json({ access_token: 'token' })
			if (value.endsWith('/sharing/get_shared_link_metadata')) return json(metadata())
			if (value.endsWith('/files/get_temporary_link')) {
				return json({ link: 'https://dl.dropboxusercontent.com/temp' })
			}
			throw new Error(`unexpected ${value}`)
		}) as unknown as typeof fetch

		await expect(
			resolver(fetchImpl).resolve({
				bindingId: 'binding',
				courseVersionId: 'version',
				sourceVideoId: 'video',
				relativePath: 'course/video.mp4',
			}),
		).resolves.toEqual({
			url: 'https://dl.dropboxusercontent.com/temp',
			providerRevision: 'dropbox-rev-1',
			providerContentHash: 'content-hash-1',
			bytes: 123,
		})
		expect(fetchImpl).toHaveBeenCalledTimes(3)
	})

	it('falls back to a per-file direct shared link', async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			const value = String(url)
			if (value.endsWith('/oauth2/token')) return json({ access_token: 'token' })
			if (value.endsWith('/sharing/get_shared_link_metadata')) return json(metadata())
			if (value.endsWith('/files/get_temporary_link')) return json({ error: 'missing' }, 409)
			if (value.endsWith('/sharing/create_shared_link_with_settings')) {
				return json({ url: 'https://www.dropbox.com/scl/fi/file?rlkey=test&dl=0' })
			}
			throw new Error(`unexpected ${value}`)
		}) as unknown as typeof fetch

		const source = await resolver(fetchImpl).resolve({
			bindingId: 'binding',
			courseVersionId: 'version',
			sourceVideoId: 'video',
			relativePath: 'course/video.mp4',
		})
		expect(source.url).toBe(
			'https://www.dropbox.com/scl/fi/file?rlkey=test&dl=1',
		)
	})

	it('uses a short-lived signed proxy only after Dropbox URL strategies fail', async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			const value = String(url)
			if (value.endsWith('/oauth2/token')) return json({ access_token: 'token' })
			if (value.endsWith('/sharing/get_shared_link_metadata')) {
				return json({ ...metadata(), path_lower: undefined })
			}
			throw new Error(`unexpected ${value}`)
		}) as unknown as typeof fetch

		const source = await resolver(fetchImpl).resolve({
			bindingId: 'binding',
			courseVersionId: 'version',
			sourceVideoId: 'video',
			relativePath: 'course/video.mp4',
		})
		const url = new URL(source.url)
		expect(url.searchParams.get('binding')).toBe('binding')
		expect(url.origin + url.pathname).toBe(
			'https://www.aihero.dev/api/course-sync/dropbox-asset',
		)
		expect(
			verifyDropboxMuxProxyToken({
				bindingId: 'binding',
				relativePath: url.searchParams.get('path') ?? '',
				expiresAt: Number(url.searchParams.get('expires')),
				suppliedSignature: url.searchParams.get('signature') ?? '',
				signingSecret: 'signing-secret',
				now: 1_001,
			}),
		).toBe(true)
		expect(verifyDropboxMuxProxyToken({
			bindingId: 'another-binding',
			relativePath: url.searchParams.get('path') ?? '',
			expiresAt: Number(url.searchParams.get('expires')),
			suppliedSignature: url.searchParams.get('signature') ?? '',
			signingSecret: 'signing-secret',
			now: 1_001,
		})).toBe(false)
	})

	it('rejects the pre-binding signature format', () => {
		const expiresAt = 10_000
		const relativePath = 'course/video.mp4'
		const legacySignature = createHmac('sha256', 'signing-secret')
			.update(`${expiresAt}:${relativePath}`)
			.digest('base64url')
		expect(verifyDropboxMuxProxyToken({
			bindingId: 'binding', relativePath, expiresAt,
			suppliedSignature: legacySignature, signingSecret: 'signing-secret', now: 1_000,
		})).toBe(false)
	})

	it('caches independent resolvers by binding id', async () => {
		const make = vi.fn((binding: CourseSyncBinding) => ({
			resolve: async () => ({
				url: binding.bindingId, providerRevision: 'rev', providerContentHash: null, bytes: 1,
			}),
		}))
		const bindingA = { ...AI_HERO_COURSE_SYNC_BINDING, bindingId: 'a' }
		const bindingB = { ...AI_HERO_COURSE_SYNC_BINDING, bindingId: 'b' }
		const scoped = createBindingScopedMuxSourceResolver(make, (id) =>
			id === 'a' ? bindingA : bindingB)
		const input = { courseVersionId: 'v', sourceVideoId: 'video', relativePath: 'course/video.mp4' }
		expect((await scoped.resolve({ ...input, bindingId: 'a' })).url).toBe('a')
		expect((await scoped.resolve({ ...input, bindingId: 'b' })).url).toBe('b')
		expect((await scoped.resolve({ ...input, bindingId: 'a' })).url).toBe('a')
		expect(make).toHaveBeenCalledTimes(2)
	})
})
