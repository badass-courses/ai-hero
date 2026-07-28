import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	adapterCreateProduct: vi.fn(),
	adapterGetContentResource: vi.fn(),
	adapterGetProduct: vi.fn(),
	adapterUpdateContentResourceFields: vi.fn(),
	adapterUpdateProduct: vi.fn(),
	contentResourceFindFirst: vi.fn(),
	createLessonSolution: vi.fn(),
	createMultipartUpload: vi.fn(),
	createPost: vi.fn(),
	createSurveyForApi: vi.fn(),
	deletePost: vi.fn(),
	deleteSolution: vi.fn(),
	deleteSurveyForApi: vi.fn(),
	dbInsert: vi.fn(),
	dbInsertValues: vi.fn(),
	dbSelect: vi.fn(),
	getAllLists: vi.fn(),
	getLessons: vi.fn(),
	getPosts: vi.fn(),
	getProductsWithFullStructure: vi.fn(),
	getMultipartPartUrl: vi.fn(),
	getProductWithFullStructure: vi.fn(),
	getSignedUrlForVideoFile: vi.fn(),
	getSolution: vi.fn(),
	getSurveyAnalyticsForApi: vi.fn(),
	getSurveyForApi: vi.fn(),
	getUserAbilityForRequest: vi.fn(),
	getVideoResource: vi.fn(),
	listSurveysForApi: vi.fn(),
	log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
	purchasesFindMany: vi.fn(),
	typesenseMultiSearch: vi.fn(),
	typesenseSearch: vi.fn(),
	typesenseUpsert: vi.fn(),
	updateSurveyForApi: vi.fn(),
	updateLesson: vi.fn(),
	updatePost: vi.fn(),
	updateSolution: vi.fn(),
	completeMultipartUpload: vi.fn(),
}))

vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		createProduct: mocks.adapterCreateProduct,
		getContentResource: mocks.adapterGetContentResource,
		getProduct: mocks.adapterGetProduct,
		updateContentResourceFields: mocks.adapterUpdateContentResourceFields,
		updateProduct: mocks.adapterUpdateProduct,
	},
	db: {
		insert: mocks.dbInsert,
		select: mocks.dbSelect,
		query: {
			contentResource: { findFirst: mocks.contentResourceFindFirst },
			purchases: { findMany: mocks.purchasesFindMany },
		},
	},
}))
vi.mock('@/inngest/events/skill-changelog', () => ({
	SKILL_CHANGELOG_PUBLISHED_EVENT: 'skill-changelog/published',
}))
vi.mock('@/inngest/inngest.server', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/lessons/lessons.service', () => {
	class LessonError extends Error {
		constructor(
			message: string,
			public statusCode = 400,
			public details?: unknown,
		) {
			super(message)
		}
	}
	mocks.getLessons.mockImplementation(({ ability }) => {
		if (ability.cannot('read', 'Content')) {
			throw new LessonError('Unauthorized', 401)
		}
		return []
	})
	mocks.updateLesson.mockImplementation(({ ability }) => {
		if (ability.cannot('update', 'Content')) {
			throw new LessonError('Forbidden', 403)
		}
		return { id: 'lesson_1' }
	})
	return {
		getLessons: mocks.getLessons,
		LessonError,
		updateLesson: mocks.updateLesson,
	}
})
vi.mock('@/lib/lists-query', () => ({ getAllLists: mocks.getAllLists }))
vi.mock('@/lib/posts/posts.service', () => {
	class PostError extends Error {
		constructor(
			message: string,
			public statusCode = 400,
			public details?: unknown,
		) {
			super(message)
		}
	}
	mocks.getPosts.mockImplementation(({ ability }) => {
		if (ability.cannot('read', 'Content')) {
			throw new PostError('Unauthorized', 401)
		}
		return []
	})
	mocks.createPost.mockImplementation(({ ability }) => {
		if (ability.cannot('create', 'Content')) {
			throw new PostError('Forbidden', 403)
		}
		return { id: 'post_1', fields: { title: 'Post' } }
	})
	mocks.updatePost.mockImplementation(({ ability }) => {
		if (ability.cannot('update', 'Content')) {
			throw new PostError('Forbidden', 403)
		}
		return { id: 'post_1' }
	})
	mocks.deletePost.mockImplementation(({ ability }) => {
		if (ability.cannot('delete', 'Content')) {
			throw new PostError('Forbidden', 403)
		}
		return { message: 'deleted' }
	})
	return {
		createPost: mocks.createPost,
		deletePost: mocks.deletePost,
		getPostById: vi.fn(),
		getPosts: mocks.getPosts,
		PostError,
		updatePost: mocks.updatePost,
	}
})
vi.mock('@/lib/products-query', () => ({
	getProductsWithFullStructure: mocks.getProductsWithFullStructure,
	getProductWithFullStructure: mocks.getProductWithFullStructure,
}))
vi.mock('@/lib/skill-changelog-query', () => ({
	getSkillChangelogForEdit: vi.fn(),
	SKILL_CHANGELOG_RESOURCE_TYPE: 'skill-changelog',
	SKILL_CHANGELOG_SLUG_PREFIX: 'skill-changelog',
}))
vi.mock('@/lib/solutions/solutions.service', () => {
	class SolutionError extends Error {
		constructor(
			message: string,
			public statusCode = 400,
			public details?: unknown,
		) {
			super(message)
		}
	}
	mocks.getSolution.mockImplementation((_lessonId, ability) => {
		if (ability.cannot('read', 'Content')) {
			throw new SolutionError('Unauthorized', 401)
		}
		return { id: 'solution_1' }
	})
	mocks.updateSolution.mockResolvedValue({ id: 'solution_1' })
	mocks.createLessonSolution.mockResolvedValue({ id: 'solution_1' })
	mocks.deleteSolution.mockResolvedValue({ message: 'deleted' })
	return {
		createSolutionForLesson: mocks.createLessonSolution,
		deleteSolutionForLesson: mocks.deleteSolution,
		getSolutionForLesson: mocks.getSolution,
		SolutionError,
		updateSolutionForLesson: mocks.updateSolution,
	}
})
vi.mock('@/lib/surveys-api', () => ({
	createSurveyForApi: mocks.createSurveyForApi,
	deleteSurveyForApi: mocks.deleteSurveyForApi,
	getSurveyAnalyticsForApi: mocks.getSurveyAnalyticsForApi,
	getSurveyForApi: mocks.getSurveyForApi,
	listSurveysForApi: mocks.listSurveysForApi,
	SurveyApiError: class SurveyApiError extends Error {},
	updateSurveyForApi: mocks.updateSurveyForApi,
}))
vi.mock('@/lib/video-resource-query', () => ({
	getVideoResource: mocks.getVideoResource,
}))
vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.getUserAbilityForRequest,
}))
vi.mock('@/lib/typesense-query', () => ({ upsertPostToTypeSense: vi.fn() }))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))
vi.mock('@/video-uploader/get-signed-s3-url', () => ({
	getSignedUrlForVideoFile: mocks.getSignedUrlForVideoFile,
}))
vi.mock('@/video-uploader/multipart-s3', () => ({
	completeMultipartUpload: mocks.completeMultipartUpload,
	createMultipartUpload: mocks.createMultipartUpload,
	getMultipartPartUrl: mocks.getMultipartPartUrl,
}))
vi.mock('typesense', () => ({
	default: {
		Client: class Client {
			multiSearch = {
				perform: mocks.typesenseMultiSearch,
			}

			collections() {
				return {
					documents: () => ({
						create: mocks.typesenseUpsert,
						search: mocks.typesenseSearch,
						update: mocks.typesenseUpsert,
						upsert: mocks.typesenseUpsert,
					}),
				}
			}
		},
	},
}))

import { createAppAbility, getAbility } from '@/ability'
import { GET as getVideo } from '@/app/api/(content)/[videoResourceId]/route'
import {
	DELETE as deleteSolution,
	GET as getSolution,
	POST as createSolution,
	PUT as updateSolution,
} from '@/app/api/(content)/lessons/[lessonId]/solution/route'
import {
	GET as getLessons,
	PUT as updateLesson,
} from '@/app/api/(content)/lessons/route'
import {
	GET as recallMemory,
	POST as storeMemory,
} from '@/app/api/(content)/memory/route'
import {
	DELETE as deletePost,
	GET as getPosts,
	POST as createPost,
	PUT as updatePost,
} from '@/app/api/(content)/posts/route'
import { GET as getEnrollment } from '@/app/api/(content)/products/[productId]/enrollment/route'
import {
	GET as getProducts,
	POST as createProduct,
	PUT as updateProduct,
} from '@/app/api/(content)/products/route'
import {
	GET as getResource,
	POST as createResource,
	PUT as updateResource,
} from '@/app/api/(content)/resources/route'
import { GET as search } from '@/app/api/(content)/search/route'
import { POST as createSkillChangelog } from '@/app/api/(content)/skills/changelog/route'
import { GET as getSurveyAnalytics } from '@/app/api/(content)/surveys/analytics/route'
import {
	DELETE as deleteSurvey,
	GET as getSurveys,
	PATCH as updateSurvey,
	POST as createSurvey,
} from '@/app/api/(content)/surveys/route'
import { POST as completeMultipartUpload } from '@/app/api/(content)/uploads/multipart/complete/route'
import { POST as createMultipartUpload } from '@/app/api/(content)/uploads/multipart/create/route'
import { GET as getMultipartPartUrl } from '@/app/api/(content)/uploads/multipart/part-url/route'
import { POST as createUpload } from '@/app/api/(content)/uploads/new/route'
import { GET as getSignedUrl } from '@/app/api/(content)/uploads/signed-url/route'
import * as videoRoute from '@/app/api/(content)/[videoResourceId]/route'
import * as solutionRoute from '@/app/api/(content)/lessons/[lessonId]/solution/route'
import * as lessonsRoute from '@/app/api/(content)/lessons/route'
import * as memoryRoute from '@/app/api/(content)/memory/route'
import * as postsRoute from '@/app/api/(content)/posts/route'
import * as availabilityRoute from '@/app/api/(content)/products/[productId]/availability/route'
import * as enrollmentRoute from '@/app/api/(content)/products/[productId]/enrollment/route'
import * as productsRoute from '@/app/api/(content)/products/route'
import * as resourcesRoute from '@/app/api/(content)/resources/route'
import * as searchRoute from '@/app/api/(content)/search/route'
import * as changelogRoute from '@/app/api/(content)/skills/changelog/route'
import * as surveyAnalyticsRoute from '@/app/api/(content)/surveys/analytics/route'
import * as surveysRoute from '@/app/api/(content)/surveys/route'
import * as multipartCompleteRoute from '@/app/api/(content)/uploads/multipart/complete/route'
import * as multipartCreateRoute from '@/app/api/(content)/uploads/multipart/create/route'
import * as multipartPartUrlRoute from '@/app/api/(content)/uploads/multipart/part-url/route'
import * as uploadNewRoute from '@/app/api/(content)/uploads/new/route'
import * as signedUrlRoute from '@/app/api/(content)/uploads/signed-url/route'
import { buildPersonalAccessTokenAbility } from '@/server/pat-scopes'

const user = { id: 'user_1', email: 'agent@example.com' }
const anonymousAuth = {
	user: null,
	ability: getAbility(),
	authMethod: 'anonymous' as const,
}
const personalAccessTokenAuth = {
	user,
	ability: buildPersonalAccessTokenAbility(['content:read']),
	authMethod: 'personal-access-token' as const,
}
const reservedScopePersonalAccessTokenAuth = {
	user,
	ability: buildPersonalAccessTokenAbility(['analytics:read']),
	authMethod: 'personal-access-token' as const,
}
const adminAuth = {
	user,
	ability: createAppAbility([{ action: 'manage', subject: 'all' }]),
	authMethod: 'device-token' as const,
}

describe('agent token route behavior', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		process.env.NEXT_PUBLIC_TYPESENSE_HOST = 'typesense.example.com'
		process.env.TYPESENSE_WRITE_API_KEY = 'test-key'
		process.env.NEXT_PUBLIC_URL = 'https://www.aihero.dev'

		mocks.dbInsert.mockReturnValue({ values: mocks.dbInsertValues })
		mocks.dbInsertValues.mockResolvedValue(undefined)
		mocks.contentResourceFindFirst.mockResolvedValue({
			id: 'resource_1',
			type: 'lesson',
			fields: {
				title: 'Resource',
				slug: 'resource',
				state: 'draft',
				visibility: 'private',
			},
			resources: [],
			resourceProducts: [],
		})
		mocks.adapterCreateProduct.mockResolvedValue({
			id: 'product_1',
			name: 'Product',
			fields: {},
		})
		mocks.adapterGetProduct.mockResolvedValue({
			id: 'product_1',
			name: 'Product',
			type: 'self-paced',
			quantityAvailable: -1,
			fields: {},
			price: { unitAmount: 100, nickname: 'Product' },
		})
		mocks.adapterUpdateProduct.mockResolvedValue({
			id: 'product_1',
			name: 'Updated Product',
			fields: {},
			price: { unitAmount: 100, nickname: 'Product' },
		})
		mocks.adapterGetContentResource.mockResolvedValue({
			id: 'resource_1',
			type: 'lesson',
			fields: {},
		})
		mocks.adapterUpdateContentResourceFields.mockResolvedValue({
			id: 'resource_1',
		})
		mocks.getProductsWithFullStructure.mockResolvedValue([])
		mocks.getProductWithFullStructure.mockResolvedValue({
			id: 'product_1',
			fields: {},
		})
		mocks.getAllLists.mockResolvedValue([])
		mocks.getSurveyForApi.mockResolvedValue({ id: 'survey_1', questions: [] })
		mocks.listSurveysForApi.mockResolvedValue([])
		mocks.createSurveyForApi.mockResolvedValue({ id: 'survey_1' })
		mocks.updateSurveyForApi.mockResolvedValue({ id: 'survey_1' })
		mocks.deleteSurveyForApi.mockResolvedValue({ deleted: true })
		mocks.getSurveyAnalyticsForApi.mockResolvedValue({ responses: [] })
		mocks.getVideoResource.mockResolvedValue({ id: 'video_1' })
		mocks.getSignedUrlForVideoFile.mockResolvedValue({ url: 'https://signed' })
		mocks.completeMultipartUpload.mockResolvedValue({ complete: true })
		mocks.createMultipartUpload.mockResolvedValue({
			key: 'key',
			uploadId: 'upload_1',
		})
		mocks.getMultipartPartUrl.mockResolvedValue({ url: 'https://signed-part' })
		mocks.typesenseSearch.mockResolvedValue({
			found: 0,
			search_time_ms: 1,
			hits: [],
		})
		mocks.typesenseMultiSearch.mockResolvedValue({
			results: [{ hits: [] }],
		})
		mocks.typesenseUpsert.mockResolvedValue({ id: 'memory_1' })
		mocks.purchasesFindMany.mockResolvedValue([])

		let selectCall = 0
		mocks.dbSelect.mockImplementation(() => {
			selectCall += 1
			if (selectCall === 1) {
				return {
					from: () => ({
						where: () => ({
							groupBy: async () => [{ status: 'Valid', count: 1 }],
						}),
					}),
				}
			}
			return {
				from: () => ({
					innerJoin: () => ({
						where: async () => [
							{
								totalMaxUses: 0,
								totalUsedCount: 0,
								bulkPurchaseCount: 0,
							},
						],
					}),
				}),
			}
		})
	})

	it.each([
		[
			'lesson PUT before ID/body validation',
			() =>
				updateLesson(
					new NextRequest('http://localhost:3000/api/lessons', {
						method: 'PUT',
					}),
				),
		],
		[
			'solution PUT before body parsing',
			() =>
				updateSolution(
					new NextRequest(
						'http://localhost:3000/api/lessons/lesson_1/solution',
						{ method: 'PUT' },
					),
					{ params: Promise.resolve({ lessonId: 'lesson_1' }) },
				),
		],
		[
			'solution POST before body parsing',
			() =>
				createSolution(
					new NextRequest(
						'http://localhost:3000/api/lessons/lesson_1/solution',
						{ method: 'POST' },
					),
					{ params: Promise.resolve({ lessonId: 'lesson_1' }) },
				),
		],
		[
			'solution DELETE before lookup',
			() =>
				deleteSolution(
					new NextRequest(
						'http://localhost:3000/api/lessons/lesson_1/solution',
						{ method: 'DELETE' },
					),
					{ params: Promise.resolve({ lessonId: 'lesson_1' }) },
				),
		],
		[
			'memory GET',
			() =>
				recallMemory(
					new NextRequest('http://localhost:3000/api/memory?q=secret'),
				),
		],
		[
			'memory POST before body parsing',
			() =>
				storeMemory(
					new NextRequest('http://localhost:3000/api/memory', {
						method: 'POST',
					}),
				),
		],
		[
			'post POST before body parsing',
			() =>
				createPost(
					new NextRequest('http://localhost:3000/api/posts', {
						method: 'POST',
					}),
				),
		],
		[
			'post PUT before ID/body validation',
			() =>
				updatePost(
					new NextRequest('http://localhost:3000/api/posts', { method: 'PUT' }),
				),
		],
		[
			'post DELETE before ID/lookup',
			() =>
				deletePost(
					new NextRequest('http://localhost:3000/api/posts', {
						method: 'DELETE',
					}),
				),
		],
		[
			'product POST before body parsing',
			() =>
				createProduct(
					new NextRequest('http://localhost:3000/api/products', {
						method: 'POST',
					}),
				),
		],
		[
			'product PUT before body parsing',
			() =>
				updateProduct(
					new NextRequest('http://localhost:3000/api/products', {
						method: 'PUT',
					}),
				),
		],
		[
			'resource POST before body parsing',
			() =>
				createResource(
					new NextRequest('http://localhost:3000/api/resources', {
						method: 'POST',
					}),
				),
		],
		[
			'resource PUT before ID/body validation',
			() =>
				updateResource(
					new NextRequest('http://localhost:3000/api/resources', {
						method: 'PUT',
					}),
				),
		],
		[
			'skills changelog POST before body parsing',
			() =>
				createSkillChangelog(
					new NextRequest('http://localhost:3000/api/skills/changelog', {
						method: 'POST',
					}),
				),
		],
		[
			'survey analytics GET before parameter validation',
			() =>
				getSurveyAnalytics(
					new NextRequest('http://localhost:3000/api/surveys/analytics'),
				),
		],
		[
			'survey POST before body parsing',
			() =>
				createSurvey(
					new NextRequest('http://localhost:3000/api/surveys', {
						method: 'POST',
					}),
				),
		],
		[
			'survey PATCH before body parsing',
			() =>
				updateSurvey(
					new NextRequest('http://localhost:3000/api/surveys', {
						method: 'PATCH',
					}),
				),
		],
		[
			'survey DELETE before ID validation',
			() =>
				deleteSurvey(
					new NextRequest('http://localhost:3000/api/surveys', {
						method: 'DELETE',
					}),
				),
		],
		[
			'multipart complete POST before body parsing',
			() =>
				completeMultipartUpload(
					new NextRequest(
						'http://localhost:3000/api/uploads/multipart/complete',
						{ method: 'POST' },
					),
				),
		],
		[
			'multipart create POST before body parsing',
			() =>
				createMultipartUpload(
					new NextRequest(
						'http://localhost:3000/api/uploads/multipart/create',
						{ method: 'POST' },
					),
				),
		],
		[
			'multipart part URL GET',
			() =>
				getMultipartPartUrl(
					new NextRequest(
						'http://localhost:3000/api/uploads/multipart/part-url',
					),
				),
		],
		[
			'new upload POST before body parsing',
			() =>
				createUpload(
					new NextRequest('http://localhost:3000/api/uploads/new', {
						method: 'POST',
					}),
				),
		],
	])('denies content:read PAT access to %s', async (_name, run) => {
		mocks.getUserAbilityForRequest.mockResolvedValue(personalAccessTokenAuth)

		const response = await run()

		expect(response.status).toBe(403)
	})

	it('closes anonymous generic resource reads before querying the database', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(anonymousAuth)

		const response = await getResource(
			new NextRequest('http://localhost:3000/api/resources?slugOrId=secret'),
		)

		expect(response.status).toBe(401)
		expect(mocks.contentResourceFindFirst).not.toHaveBeenCalled()
	})

	it('allows privileged resource reads but strips nested Mux capability fields', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(personalAccessTokenAuth)
		mocks.contentResourceFindFirst.mockResolvedValue({
			id: 'lesson_1',
			type: 'lesson',
			fields: { title: 'Draft lesson', muxAssetId: 'asset-secret' },
			resources: [
				{
					resource: {
						id: 'video_1',
						fields: { muxPlaybackId: 'playback-secret' },
					},
				},
			],
		})

		const response = await getResource(
			new NextRequest('http://localhost:3000/api/resources?slugOrId=lesson_1'),
		)
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(JSON.stringify(body)).not.toContain('asset-secret')
		expect(JSON.stringify(body)).not.toContain('playback-secret')
	})

	it('denies signed URL capability to content:read PATs', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(personalAccessTokenAuth)

		const response = await getSignedUrl(
			new NextRequest(
				'http://localhost:3000/api/uploads/signed-url?objectName=secret.mp4',
			),
		)

		expect(response.status).toBe(403)
		expect(mocks.getSignedUrlForVideoFile).not.toHaveBeenCalled()
	})

	it('keeps signed URL access for an admin device token', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(adminAuth)
		mocks.getSignedUrlForVideoFile.mockResolvedValue({ url: 'https://signed' })

		const response = await getSignedUrl(
			new NextRequest(
				'http://localhost:3000/api/uploads/signed-url?objectName=video.mp4',
			),
		)

		expect(response.status).toBe(200)
		expect(mocks.getSignedUrlForVideoFile).toHaveBeenCalledWith({
			filename: 'video.mp4',
		})
	})

	it('allows privileged list reads for posts, lessons, solutions, products, and surveys', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(personalAccessTokenAuth)
		mocks.getPosts.mockResolvedValue([])
		mocks.getLessons.mockResolvedValue([])
		mocks.getSolution.mockResolvedValue({ id: 'solution_1' })
		mocks.getProductsWithFullStructure.mockResolvedValue([])
		mocks.listSurveysForApi.mockResolvedValue([])

		const solutionContext = {
			params: Promise.resolve({ lessonId: 'lesson_1' }),
		}
		const responses = await Promise.all([
			getPosts(new NextRequest('http://localhost:3000/api/posts')),
			getLessons(new NextRequest('http://localhost:3000/api/lessons')),
			getSolution(
				new NextRequest('http://localhost:3000/api/lessons/lesson_1/solution'),
				solutionContext,
			),
			getProducts(new NextRequest('http://localhost:3000/api/products')),
			getSurveys(new NextRequest('http://localhost:3000/api/surveys')),
		])

		expect(responses.map((response) => response.status)).toEqual([
			200, 200, 200, 200, 200,
		])
	})

	it('allows a content:read PAT to fetch survey definitions', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(personalAccessTokenAuth)
		mocks.getSurveyForApi.mockResolvedValue({ id: 'survey_1', questions: [] })

		const response = await getSurveys(
			new NextRequest('http://localhost:3000/api/surveys?slugOrId=survey_1'),
		)

		expect(response.status).toBe(200)
		expect(mocks.getSurveyForApi).toHaveBeenCalledWith('survey_1')
	})

	it('sanitizes capability-bearing fields from nested product reads', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(personalAccessTokenAuth)
		mocks.getProductsWithFullStructure.mockResolvedValue([
			{
				id: 'product_1',
				resources: [
					{
						resource: {
							id: 'video_1',
							fields: { muxPlaybackId: 'playback-secret' },
						},
					},
				],
			},
		])

		const response = await getProducts(
			new NextRequest('http://localhost:3000/api/products'),
		)
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(JSON.stringify(body)).not.toContain('playback-secret')
	})

	it('filters anonymous search and keeps the response field allowlist', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(anonymousAuth)
		mocks.typesenseSearch.mockResolvedValue({
			found: 1,
			search_time_ms: 2,
			hits: [
				{
					document: {
						id: 'post_1',
						type: 'article',
						title: 'Public post',
						slug: 'public-post',
						summary: 'Summary',
						description: 'Must stay hidden',
						embedding: [1, 2, 3],
					},
				},
			],
		})

		const response = await search(
			new NextRequest('http://localhost:3000/api/search?q=public'),
		)
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(mocks.typesenseSearch).toHaveBeenCalledWith(
			expect.objectContaining({
				filter_by: 'state:=published && visibility:=public',
				exclude_fields: 'embedding,description',
			}),
		)
		expect(body.result.hits[0]).toEqual({
			id: 'post_1',
			type: 'article',
			title: 'Public post',
			slug: 'public-post',
			url: 'https://www.aihero.dev/public-post',
			summary: 'Summary',
		})
	})

	it('rejects Typesense filter syntax in the type parameter', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(anonymousAuth)

		const response = await search(
			new NextRequest(
				'http://localhost:3000/api/search?q=public&type=lesson%20%7C%7C%20state%3A%3Ddraft',
			),
		)

		expect(response.status).toBe(400)
		expect(mocks.typesenseSearch).not.toHaveBeenCalled()
	})

	it('removes state and visibility filters for privileged PAT search', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(personalAccessTokenAuth)
		mocks.typesenseSearch.mockResolvedValue({
			found: 0,
			search_time_ms: 1,
			hits: [],
		})

		const response = await search(
			new NextRequest('http://localhost:3000/api/search?q=draft'),
		)

		expect(response.status).toBe(200)
		expect(mocks.typesenseSearch).toHaveBeenCalledWith(
			expect.not.objectContaining({ filter_by: expect.anything() }),
		)
	})

	it('denies raw video resource payloads before lookup for a content PAT', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(personalAccessTokenAuth)

		const response = await getVideo(
			new NextRequest('http://localhost:3000/api/video_1'),
			{ params: Promise.resolve({ videoResourceId: 'video_1' }) },
		)

		expect(response.status).toBe(403)
		expect(await response.json()).toMatchObject({ docs: '/api' })
		expect(mocks.getVideoResource).not.toHaveBeenCalled()
	})

	it('returns 403 instead of 401 for excluded enrollment analytics', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(personalAccessTokenAuth)

		const response = await getEnrollment(
			new NextRequest(
				'http://localhost:3000/api/products/product_1/enrollment',
			),
			{ params: Promise.resolve({ productId: 'product_1' }) },
		)

		expect(response.status).toBe(403)
		expect(await response.json()).toMatchObject({ docs: '/api' })
	})

	it('documents the legacy 401 returned to a valid PAT without content read ability', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(
			reservedScopePersonalAccessTokenAuth,
		)

		const response = await getProducts(
			new NextRequest('http://localhost:3000/api/products'),
		)

		expect(response.status).toBe(401)
		expect(await response.json()).toMatchObject({ docs: '/api' })
	})

	describe('approved 50-row behavioral matrix', () => {
		type MatrixTokenKind =
			| 'anonymous'
			| 'content:read PAT'
			| 'admin device token'
		type MatrixBehaviorRow = {
			name: string
			run: () => Response | Promise<Response>
			expected: Record<MatrixTokenKind, number>
		}

		const jsonRequest = (url: string, method: string, body: unknown) =>
			new NextRequest(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			})
		const lessonContext = {
			params: Promise.resolve({ lessonId: 'lesson_1' }),
		}
		const productContext = {
			params: Promise.resolve({ productId: 'product_1' }),
		}
		const expected = (
			anonymous: number,
			pat: number,
			admin: number,
		): Record<MatrixTokenKind, number> => ({
			anonymous,
			'content:read PAT': pat,
			'admin device token': admin,
		})

		const matrixRows: MatrixBehaviorRow[] = [
			{
				name: '/api/[videoResourceId] OPTIONS',
				run: () => videoRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/[videoResourceId] GET',
				run: () =>
					videoRoute.GET(new NextRequest('http://localhost:3000/api/video_1'), {
						params: Promise.resolve({ videoResourceId: 'video_1' }),
					}),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/lessons/[lessonId]/solution OPTIONS',
				run: () => solutionRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/lessons/[lessonId]/solution GET',
				run: () =>
					solutionRoute.GET(
						new NextRequest(
							'http://localhost:3000/api/lessons/lesson_1/solution',
						),
						lessonContext,
					),
				expected: expected(401, 200, 200),
			},
			{
				name: '/api/lessons/[lessonId]/solution PUT',
				run: () =>
					solutionRoute.PUT(
						jsonRequest(
							'http://localhost:3000/api/lessons/lesson_1/solution',
							'PUT',
							{},
						),
						lessonContext,
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/lessons/[lessonId]/solution POST',
				run: () =>
					solutionRoute.POST(
						jsonRequest(
							'http://localhost:3000/api/lessons/lesson_1/solution',
							'POST',
							{},
						),
						lessonContext,
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/lessons/[lessonId]/solution DELETE',
				run: () =>
					solutionRoute.DELETE(
						new NextRequest(
							'http://localhost:3000/api/lessons/lesson_1/solution',
							{ method: 'DELETE' },
						),
						lessonContext,
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/lessons OPTIONS',
				run: () => lessonsRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/lessons GET',
				run: () =>
					lessonsRoute.GET(
						new NextRequest('http://localhost:3000/api/lessons'),
					),
				expected: expected(401, 200, 200),
			},
			{
				name: '/api/lessons PUT',
				run: () =>
					lessonsRoute.PUT(
						jsonRequest(
							'http://localhost:3000/api/lessons?id=lesson_1',
							'PUT',
							{},
						),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/memory OPTIONS',
				run: () => memoryRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/memory GET',
				run: () =>
					memoryRoute.GET(
						new NextRequest('http://localhost:3000/api/memory?q=test'),
					),
				expected: expected(200, 403, 200),
			},
			{
				name: '/api/memory POST',
				run: () =>
					memoryRoute.POST(
						jsonRequest('http://localhost:3000/api/memory', 'POST', {
							observation: 'Observation',
							category: 'process',
						}),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/posts OPTIONS',
				run: () => postsRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/posts GET',
				run: () =>
					postsRoute.GET(new NextRequest('http://localhost:3000/api/posts')),
				expected: expected(401, 200, 200),
			},
			{
				name: '/api/posts POST',
				run: () =>
					postsRoute.POST(
						jsonRequest('http://localhost:3000/api/posts', 'POST', {
							title: 'Post',
						}),
					),
				expected: expected(401, 403, 201),
			},
			{
				name: '/api/posts PUT',
				run: () =>
					postsRoute.PUT(
						jsonRequest('http://localhost:3000/api/posts?id=post_1', 'PUT', {}),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/posts DELETE',
				run: () =>
					postsRoute.DELETE(
						new NextRequest('http://localhost:3000/api/posts?id=post_1', {
							method: 'DELETE',
						}),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/products/[productId]/availability OPTIONS',
				run: () => availabilityRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/products/[productId]/availability GET',
				run: () =>
					availabilityRoute.GET(
						new NextRequest(
							'http://localhost:3000/api/products/product_1/availability',
						),
						productContext,
					),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/products/[productId]/enrollment OPTIONS',
				run: () => enrollmentRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/products/[productId]/enrollment GET',
				run: () =>
					enrollmentRoute.GET(
						new NextRequest(
							'http://localhost:3000/api/products/product_1/enrollment',
						),
						productContext,
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/products OPTIONS',
				run: () => productsRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/products GET',
				run: () =>
					productsRoute.GET(
						new NextRequest('http://localhost:3000/api/products'),
					),
				expected: expected(401, 200, 200),
			},
			{
				name: '/api/products POST',
				run: () =>
					productsRoute.POST(
						jsonRequest('http://localhost:3000/api/products', 'POST', {
							name: 'Product',
							type: 'self-paced',
							price: 100,
						}),
					),
				expected: expected(401, 403, 201),
			},
			{
				name: '/api/products PUT',
				run: () =>
					productsRoute.PUT(
						jsonRequest('http://localhost:3000/api/products', 'PUT', {
							id: 'product_1',
							name: 'Updated Product',
						}),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/resources OPTIONS',
				run: () => resourcesRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/resources GET',
				run: () =>
					resourcesRoute.GET(
						new NextRequest(
							'http://localhost:3000/api/resources?slugOrId=resource_1',
						),
					),
				expected: expected(401, 200, 200),
			},
			{
				name: '/api/resources PUT',
				run: () =>
					resourcesRoute.PUT(
						jsonRequest(
							'http://localhost:3000/api/resources?id=resource_1',
							'PUT',
							{ fields: {} },
						),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/resources POST',
				run: () =>
					resourcesRoute.POST(
						jsonRequest('http://localhost:3000/api/resources', 'POST', {
							type: 'lesson',
							title: 'Lesson',
						}),
					),
				expected: expected(401, 403, 201),
			},
			{
				name: '/api/search OPTIONS',
				run: () => searchRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/search GET',
				run: () =>
					searchRoute.GET(
						new NextRequest('http://localhost:3000/api/search?q=test'),
					),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/skills/changelog OPTIONS',
				run: () => changelogRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/skills/changelog POST',
				run: () =>
					changelogRoute.POST(
						jsonRequest('http://localhost:3000/api/skills/changelog', 'POST', {
							title: 'Changelog',
						}),
					),
				expected: expected(401, 403, 201),
			},
			{
				name: '/api/surveys/analytics OPTIONS',
				run: () => surveyAnalyticsRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/surveys/analytics GET',
				run: () =>
					surveyAnalyticsRoute.GET(
						new NextRequest(
							'http://localhost:3000/api/surveys/analytics?slugOrId=survey_1',
						),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/surveys OPTIONS',
				run: () => surveysRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/surveys GET',
				run: () =>
					surveysRoute.GET(
						new NextRequest('http://localhost:3000/api/surveys'),
					),
				expected: expected(401, 200, 200),
			},
			{
				name: '/api/surveys POST',
				run: () =>
					surveysRoute.POST(
						jsonRequest('http://localhost:3000/api/surveys', 'POST', {}),
					),
				expected: expected(401, 403, 201),
			},
			{
				name: '/api/surveys PATCH',
				run: () =>
					surveysRoute.PATCH(
						jsonRequest('http://localhost:3000/api/surveys', 'PATCH', {}),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/surveys DELETE',
				run: () =>
					surveysRoute.DELETE(
						new NextRequest('http://localhost:3000/api/surveys?id=survey_1', {
							method: 'DELETE',
						}),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/uploads/multipart/complete OPTIONS',
				run: () => multipartCompleteRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/uploads/multipart/complete POST',
				run: () =>
					multipartCompleteRoute.POST(
						jsonRequest(
							'http://localhost:3000/api/uploads/multipart/complete',
							'POST',
							{
								key: 'key',
								uploadId: 'upload_1',
								parts: [{ partNumber: 1, etag: 'etag' }],
							},
						),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/uploads/multipart/create OPTIONS',
				run: () => multipartCreateRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/uploads/multipart/create POST',
				run: () =>
					multipartCreateRoute.POST(
						jsonRequest(
							'http://localhost:3000/api/uploads/multipart/create',
							'POST',
							{ filename: 'video.mp4' },
						),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/uploads/multipart/part-url OPTIONS',
				run: () => multipartPartUrlRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/uploads/multipart/part-url GET',
				run: () =>
					multipartPartUrlRoute.GET(
						new NextRequest(
							'http://localhost:3000/api/uploads/multipart/part-url?key=key&uploadId=upload_1&partNumber=1',
						),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/uploads/new OPTIONS',
				run: () => uploadNewRoute.OPTIONS(),
				expected: expected(200, 200, 200),
			},
			{
				name: '/api/uploads/new POST',
				run: () =>
					uploadNewRoute.POST(
						jsonRequest('http://localhost:3000/api/uploads/new', 'POST', {
							file: { url: 'https://example.com/video.mp4', name: 'video.mp4' },
							metadata: { parentResourceId: 'lesson_1' },
						}),
					),
				expected: expected(401, 403, 200),
			},
			{
				name: '/api/uploads/signed-url GET',
				run: () =>
					signedUrlRoute.GET(
						new NextRequest(
							'http://localhost:3000/api/uploads/signed-url?objectName=video.mp4',
						),
					),
				expected: expected(401, 403, 200),
			},
		]

		const cases = matrixRows.flatMap((row) =>
			(['anonymous', 'content:read PAT', 'admin device token'] as const).map(
				(tokenKind) => ({
					name: row.name,
					run: row.run,
					tokenKind,
					expectedStatus: row.expected[tokenKind],
				}),
			),
		)

		it('matches the approved 50 route-method rows and expands to 150 behavioral cases', () => {
			const approvedRows = readFileSync(
				resolve(
					process.cwd(),
					'../../.brain/projects/agent-content-tokens/coverage-matrix-draft.svx',
				),
				'utf8',
			)
				.split('\n')
				.filter((line) => /^\| `\/api\//.test(line))
				.map((line) => {
					const [route, method] = line
						.split('|')
						.slice(1, 3)
						.map((cell) => cell.trim().replaceAll('`', ''))
					return `${route} ${method}`
				})
				.sort()

			expect(matrixRows).toHaveLength(50)
			expect(matrixRows.map((row) => row.name).sort()).toEqual(approvedRows)
			expect(cases).toHaveLength(150)
		})

		it.each(cases)(
			'$name with $tokenKind returns $expectedStatus',
			async ({ expectedStatus, run, tokenKind }) => {
				mocks.getUserAbilityForRequest.mockResolvedValue(
					tokenKind === 'anonymous'
						? anonymousAuth
						: tokenKind === 'content:read PAT'
							? personalAccessTokenAuth
							: adminAuth,
				)

				const response = await run()

				expect(response.status).toBe(expectedStatus)
			},
		)
	})
})
