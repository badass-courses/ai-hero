import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	createYouTubeLiveBroadcast: vi.fn(),
	getYouTubeLiveBroadcast: vi.fn(),
	listYouTubeLiveBroadcasts: vi.fn(),
	listYouTubeLiveStreams: vi.fn(),
	updateYouTubeLiveBroadcast: vi.fn(),
	revalidateTag: vi.fn(),
	getUserAbilityForRequest: vi.fn(),
	getServerAuthSession: vi.fn(),
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		flush: vi.fn(),
	},
}))

vi.mock('@/lib/youtube-live-broadcasts', () => ({
	createYouTubeLiveBroadcast: mocks.createYouTubeLiveBroadcast,
	DEFAULT_YOUTUBE_LIVE_THUMBNAIL_URL:
		'https://res.cloudinary.com/total-typescript/image/upload/v1779101607/ai-coding-for-real-engineers-office-hours-thumbnail.jpg',
	getYouTubeLiveBroadcast: mocks.getYouTubeLiveBroadcast,
	listYouTubeLiveBroadcasts: mocks.listYouTubeLiveBroadcasts,
	listYouTubeLiveStreams: mocks.listYouTubeLiveStreams,
	updateYouTubeLiveBroadcast: mocks.updateYouTubeLiveBroadcast,
}))

vi.mock('next/cache', () => ({
	revalidateTag: mocks.revalidateTag,
}))

vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.getUserAbilityForRequest,
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))

vi.mock('@/server/logger', () => ({
	log: mocks.log,
	serializeError: (error: unknown) => ({
		message: error instanceof Error ? error.message : String(error),
	}),
}))

vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))

import { POST as createBroadcast } from '../route'
import { POST as previewCreateBroadcast } from '../preview/route'
import { PATCH as updateBroadcast } from '../[id]/route'
import { PATCH as previewUpdateBroadcast } from '../[id]/preview/route'

function adminAuth() {
	return {
		user: {
			id: 'user_admin',
			email: 'admin@example.com',
			name: 'Admin',
		},
		ability: {
			can: vi.fn((action: string, subject: string) => {
				return action === 'manage' && subject === 'all'
			}),
		},
	}
}

function jsonRequest(method: 'PATCH' | 'POST', path: string, body: unknown) {
	return new NextRequest(`http://localhost:3000${path}`, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
}

function postRequest(path: string, body: unknown) {
	return jsonRequest('POST', path, body)
}

function patchRequest(path: string, body: unknown) {
	return jsonRequest('PATCH', path, body)
}

const createBody = {
	title: 'AI Hero Office Hours',
	description: 'Bring questions.',
	scheduledStartTime: '2026-06-01T17:00:00.000Z',
	scheduledEndTime: '2026-06-01T18:00:00.000Z',
	privacyStatus: 'unlisted',
}

const defaultStream = {
	id: 'stream_default',
	title: 'Default stream key',
	streamStatus: 'ready',
	healthStatus: 'good',
}

const createdBroadcast = {
	id: 'broadcast_123',
	title: createBody.title,
	description: createBody.description,
	scheduledStartTime: createBody.scheduledStartTime,
	scheduledEndTime: createBody.scheduledEndTime,
	actualStartTime: null,
	actualEndTime: null,
	lifeCycleStatus: 'created',
	privacyStatus: 'unlisted',
	boundStreamId: defaultStream.id,
	watchUrl: 'https://www.youtube.com/watch?v=broadcast_123',
	raw: { id: 'broadcast_123' },
}

const defaultThumbnailUrl =
	'https://res.cloudinary.com/total-typescript/image/upload/v1779101607/ai-coding-for-real-engineers-office-hours-thumbnail.jpg'

describe('AI Hero YouTube live broadcast admin API', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getUserAbilityForRequest.mockResolvedValue(adminAuth())
		mocks.getServerAuthSession.mockResolvedValue({
			session: null,
			ability: { can: vi.fn(() => false) },
		})
		mocks.listYouTubeLiveStreams.mockResolvedValue([defaultStream])
		mocks.createYouTubeLiveBroadcast.mockResolvedValue(createdBroadcast)
		mocks.getYouTubeLiveBroadcast.mockResolvedValue(createdBroadcast)
		mocks.updateYouTubeLiveBroadcast.mockResolvedValue({
			...createdBroadcast,
			title: 'Updated Office Hours',
		})
	})

	it('previews a create payload without creating a YouTube broadcast', async () => {
		const response = await previewCreateBroadcast(
			postRequest('/api/admin/youtube/live-broadcasts/preview', createBody),
		)

		expect(response.status).toBe(200)
		const json = await response.json()
		expect(json.ok).toBe(true)
		expect(json.preview.payload.title).toBe(createBody.title)
		expect(json.preview.stream.id).toBe(defaultStream.id)
		expect(mocks.createYouTubeLiveBroadcast).not.toHaveBeenCalled()
	})

	it('refuses to create without explicit confirmation', async () => {
		const response = await createBroadcast(
			postRequest('/api/admin/youtube/live-broadcasts', createBody),
		)

		expect(response.status).toBe(409)
		const json = await response.json()
		expect(json.error.code).toBe('CONFIRMATION_REQUIRED')
		expect(mocks.createYouTubeLiveBroadcast).not.toHaveBeenCalled()
	})

	it('creates a confirmed broadcast, revalidates cached live lists, and strips raw YouTube payloads', async () => {
		const response = await createBroadcast(
			postRequest('/api/admin/youtube/live-broadcasts', {
				...createBody,
				confirm: 'CREATE_YOUTUBE_BROADCAST',
			}),
		)

		expect(response.status).toBe(201)
		expect(mocks.createYouTubeLiveBroadcast).toHaveBeenCalledWith({
			...createBody,
			streamId: defaultStream.id,
			thumbnailUrl: defaultThumbnailUrl,
		})
		expect(mocks.revalidateTag).toHaveBeenCalledWith(
			'youtube-live-broadcasts',
			'max',
		)
		expect(mocks.revalidateTag).toHaveBeenCalledWith(
			'youtube-live-broadcasts-active',
			'max',
		)

		const json = await response.json()
		expect(json.broadcast.watchUrl).toBe(createdBroadcast.watchUrl)
		expect(json.broadcast.raw).toBeUndefined()
	})

	it('previews an update payload without updating a YouTube broadcast', async () => {
		const response = await previewUpdateBroadcast(
			patchRequest('/api/admin/youtube/live-broadcasts/broadcast_123/preview', {
				title: 'Updated Office Hours',
			}),
			{ params: Promise.resolve({ id: 'broadcast_123' }) },
		)

		expect(response.status).toBe(200)
		const json = await response.json()
		expect(json.ok).toBe(true)
		expect(json.preview.current.id).toBe('broadcast_123')
		expect(json.preview.payload.title).toBe('Updated Office Hours')
		expect(mocks.updateYouTubeLiveBroadcast).not.toHaveBeenCalled()
	})

	it('refuses to update without explicit confirmation', async () => {
		const response = await updateBroadcast(
			patchRequest('/api/admin/youtube/live-broadcasts/broadcast_123', {
				title: 'Updated Office Hours',
			}),
			{ params: Promise.resolve({ id: 'broadcast_123' }) },
		)

		expect(response.status).toBe(409)
		const json = await response.json()
		expect(json.error.code).toBe('CONFIRMATION_REQUIRED')
		expect(mocks.updateYouTubeLiveBroadcast).not.toHaveBeenCalled()
	})

	it('updates a confirmed broadcast and revalidates cached live lists', async () => {
		const response = await updateBroadcast(
			patchRequest('/api/admin/youtube/live-broadcasts/broadcast_123', {
				title: 'Updated Office Hours',
				confirm: 'UPDATE_YOUTUBE_BROADCAST',
			}),
			{ params: Promise.resolve({ id: 'broadcast_123' }) },
		)

		expect(response.status).toBe(200)
		expect(mocks.updateYouTubeLiveBroadcast).toHaveBeenCalledWith({
			id: 'broadcast_123',
			title: 'Updated Office Hours',
		})
		expect(mocks.revalidateTag).toHaveBeenCalledWith(
			'youtube-live-broadcasts',
			'max',
		)
		expect(mocks.revalidateTag).toHaveBeenCalledWith(
			'youtube-live-broadcasts-active',
			'max',
		)
	})
})
