import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	createShortlink,
	getShortlinkBySlug,
	recordClick,
	updateShortlink,
} from './shortlinks-query'
import { ShortlinkMetadataSchema } from './shortlinks-types'

const mocks = vi.hoisted(() => {
	const findFirst = vi.fn()
	const redisGet = vi.fn()
	const redisSet = vi.fn()
	const redisDel = vi.fn()
	const updateWhere = vi.fn()
	const updateSet = vi.fn(() => ({ where: updateWhere }))
	const update = vi.fn(() => ({ set: updateSet }))
	const insertValues = vi.fn()
	const insert = vi.fn(() => ({ values: insertValues }))

	return {
		findFirst,
		redisGet,
		redisSet,
		redisDel,
		update,
		updateSet,
		updateWhere,
		insert,
		insertValues,
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	}
})

vi.mock('@/db', () => ({
	db: {
		query: {
			shortlink: {
				findFirst: mocks.findFirst,
			},
		},
		update: mocks.update,
		insert: mocks.insert,
	},
}))

vi.mock('@/server/auth', () => ({
	getServerAuthSession: vi.fn(),
}))

vi.mock('@/server/logger', () => ({
	log: mocks.log,
}))

vi.mock('@/server/redis-client', () => ({
	redis: {
		get: mocks.redisGet,
		set: mocks.redisSet,
		del: mocks.redisDel,
	},
}))

vi.mock('next/cache', () => ({
	revalidateTag: vi.fn(),
}))

vi.mock('@coursebuilder/utils/guid', () => ({
	guid: () => 'guid_123',
}))

const allowedAuth = {
	ability: {
		can: () => true,
	} as any,
}

const metadataV1 = {
	schemaVersion: 1,
	campaign: 'cohort_004',
	campaignPhase: 'warmup',
	sourceSurface: 'broadcast',
	sourceId: 'cc004_warmup_01',
	contentSlug: 'agentic-workflows-real-code',
	contentTopic: 'ai_workflow',
	contentIntent: 'problem_aware',
	valuePath: 'ai_coding_workflow',
	createdFor: 'campaign',
} as const

beforeEach(() => {
	vi.clearAllMocks()
})

const valuePathMetadata = {
	...metadataV1,
	linkRole: 'share_value_path',
	signupSurface: 'skills_newsletter',
} as const

describe('shortlink metadata persistence', () => {
	it('accepts value path link role and signup surface metadata', () => {
		expect(ShortlinkMetadataSchema.parse(valuePathMetadata)).toEqual(
			valuePathMetadata,
		)
	})

	it('rejects invalid value path link metadata fields', () => {
		expect(() =>
			ShortlinkMetadataSchema.parse({
				...metadataV1,
				linkRole: 'team_share',
			}),
		).toThrow()
		expect(() =>
			ShortlinkMetadataSchema.parse({
				...metadataV1,
				signupSurface: 'footer_form',
			}),
		).toThrow()
	})

	it('preserves existing metadata when update input omits metadata', async () => {
		mocks.findFirst
			.mockResolvedValueOnce({
				id: 'shortlink_123',
				slug: 'cc004-warmup-01',
				url: 'https://www.aihero.dev/old',
				description: 'old',
				metadata: metadataV1,
			})
			.mockResolvedValueOnce({
				id: 'shortlink_123',
				slug: 'cc004-warmup-01',
				url: 'https://www.aihero.dev/new',
				description: 'old',
				metadata: metadataV1,
			})

		await updateShortlink(
			{ id: 'shortlink_123', url: 'https://www.aihero.dev/new' },
			allowedAuth,
		)

		expect(mocks.updateSet).toHaveBeenCalledWith(
			expect.objectContaining({ metadata: metadataV1 }),
		)
	})

	it('creates shortlinks with value path metadata', async () => {
		mocks.findFirst.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
			id: 'shortlink_123',
			slug: 'skills-share',
			url: 'https://www.aihero.dev/skills',
			description: 'Skills share',
			metadata: valuePathMetadata,
		})
		mocks.insertValues.mockReturnValueOnce({
			$returningId: vi.fn().mockResolvedValue([{ id: 'shortlink_123' }]),
		})

		await createShortlink(
			{
				slug: 'skills-share',
				url: 'https://www.aihero.dev/skills',
				description: 'Skills share',
				metadata: valuePathMetadata,
			},
			allowedAuth,
		)

		expect(mocks.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({ metadata: valuePathMetadata }),
		)
	})

	it('updates shortlinks with value path metadata', async () => {
		mocks.findFirst
			.mockResolvedValueOnce({
				id: 'shortlink_123',
				slug: 'cc004-warmup-01',
				url: 'https://www.aihero.dev/old',
				description: 'old',
				metadata: metadataV1,
			})
			.mockResolvedValueOnce({
				id: 'shortlink_123',
				slug: 'cc004-warmup-01',
				url: 'https://www.aihero.dev/old',
				description: 'old',
				metadata: valuePathMetadata,
			})

		await updateShortlink(
			{ id: 'shortlink_123', metadata: valuePathMetadata },
			allowedAuth,
		)

		expect(mocks.updateSet).toHaveBeenCalledWith(
			expect.objectContaining({ metadata: valuePathMetadata }),
		)
	})

	it('clears existing metadata when update input passes null metadata', async () => {
		mocks.findFirst
			.mockResolvedValueOnce({
				id: 'shortlink_123',
				slug: 'cc004-warmup-01',
				url: 'https://www.aihero.dev/old',
				description: 'old',
				metadata: metadataV1,
			})
			.mockResolvedValueOnce({
				id: 'shortlink_123',
				slug: 'cc004-warmup-01',
				url: 'https://www.aihero.dev/old',
				description: 'old',
				metadata: null,
			})

		await updateShortlink({ id: 'shortlink_123', metadata: null }, allowedAuth)

		expect(mocks.updateSet).toHaveBeenCalledWith(
			expect.objectContaining({ metadata: null }),
		)
	})
})

describe('getShortlinkBySlug', () => {
	it('returns a valid cached shortlink without hitting the database', async () => {
		const cached = {
			id: 'shortlink_123',
			slug: 'valid-link',
			url: 'https://www.aihero.dev/valid',
			description: null,
			metadata: null,
			clicks: 0,
			createdById: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		}
		mocks.redisGet.mockResolvedValueOnce(cached)

		await expect(getShortlinkBySlug('valid-link')).resolves.toEqual(cached)

		expect(mocks.findFirst).not.toHaveBeenCalled()
		expect(mocks.redisDel).not.toHaveBeenCalled()
	})

	it('deletes malformed cached shortlinks and falls back to the database', async () => {
		const dbLink = {
			id: 'shortlink_456',
			slug: 'fixed-link',
			url: 'https://www.aihero.dev/fixed',
			description: null,
			metadata: null,
			clicks: 0,
			createdById: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		}
		mocks.redisGet.mockResolvedValueOnce({
			id: 'shortlink_bad',
			slug: 'fixed-link',
			url: undefined,
		})
		mocks.findFirst.mockResolvedValueOnce(dbLink)

		await expect(getShortlinkBySlug('fixed-link')).resolves.toEqual(dbLink)

		expect(mocks.redisDel).toHaveBeenCalledWith('shortlink:fixed-link')
		expect(mocks.redisSet).toHaveBeenCalledWith('shortlink:fixed-link', dbLink)
	})

	it('returns null for malformed database shortlinks instead of caching them', async () => {
		mocks.redisGet.mockResolvedValueOnce(null)
		mocks.findFirst.mockResolvedValueOnce({
			id: 'shortlink_bad',
			slug: 'bad-link',
			url: 'undefined',
		})

		await expect(getShortlinkBySlug('bad-link')).resolves.toBeNull()

		expect(mocks.redisSet).not.toHaveBeenCalled()
	})
})

describe('recordClick', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('snapshots current shortlink metadata onto the click event', async () => {
		mocks.findFirst.mockResolvedValueOnce({
			id: 'shortlink_123',
			slug: 'cc004-warmup-01',
			metadata: valuePathMetadata,
		})

		await recordClick('cc004-warmup-01', {
			referrer: 'https://example.com/email',
			userAgent: 'Mozilla/5.0',
			country: 'US',
			device: 'desktop',
		})

		expect(mocks.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				shortlinkId: 'shortlink_123',
				referrer: 'https://example.com/email',
				userAgent: 'Mozilla/5.0',
				country: 'US',
				device: 'desktop',
				metadata: valuePathMetadata,
			}),
		)
	})

	it('stores mapped click metadata snapshots for known legacy shortlinks', async () => {
		mocks.findFirst.mockResolvedValueOnce({
			id: 'shortlink_legacy_known',
			slug: 'hUsWyq',
			metadata: null,
		})

		await recordClick('hUsWyq', {})

		expect(mocks.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				shortlinkId: 'shortlink_legacy_known',
				metadata: expect.objectContaining({
					campaign: 'c004',
					sourceId: 'x_launch_post',
				}),
			}),
		)
	})

	it('stores a null click metadata snapshot for unmapped legacy shortlinks', async () => {
		mocks.findFirst.mockResolvedValueOnce({
			id: 'shortlink_legacy',
			slug: 'legacy-link',
			metadata: null,
		})

		await recordClick('legacy-link', {})

		expect(mocks.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				shortlinkId: 'shortlink_legacy',
				metadata: null,
			}),
		)
	})
})
