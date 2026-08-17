import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	subscribeToEndpoint: vi.fn(),
	compoundSubscribeToList: vi.fn(),
	log: {
		info: vi.fn(),
		warn: vi.fn(),
	},
}))

vi.mock('@/env.mjs', () => ({
	env: {
		CONVERTKIT_API_KEY: 'test-api-key',
		CONVERTKIT_API_SECRET: 'test-api-secret',
		CONVERTKIT_SIGNUP_FORM: 'default-form',
	},
}))

vi.mock('@/server/logger', () => ({ log: mocks.log }))

vi.mock('@coursebuilder/core/providers/convertkit', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('@coursebuilder/core/providers/convertkit')
		>()
	return {
		...actual,
		default: () => ({
			id: 'convertkit',
			name: 'Convertkit',
			type: 'email-list',
			defaultListType: 'form',
			defaultListId: 'default-form',
			subscribeToList: mocks.compoundSubscribeToList,
		}),
		subscribeToEndpoint: mocks.subscribeToEndpoint,
	}
})

import { ConvertKitApiError } from '@coursebuilder/core/providers/convertkit'

import {
	KIT_SUBSCRIBE_FAILURE_PREFIX,
	KitSubscribeError,
	emailListProvider,
	subscribeToKitListWithoutFields,
} from './email-list-provider'

const user = {
	id: 'user-1',
	email: 'reader@example.com',
	name: 'Reader',
	emailVerified: null,
}

const formOptions = {
	listId: '9376133',
	listType: 'form',
	user,
	fields: { dynamic_answer_2026: 'yes' },
} as Parameters<typeof emailListProvider.subscribeToList>[0]

function kitError(status: number) {
	return new ConvertKitApiError({
		message: `Kit failed with ${status}`,
		status,
		statusText: 'Error',
		bodySnippet: '',
		responseHeaders: {},
	})
}

describe('emailListProvider field-writing contract', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.log.info.mockResolvedValue(undefined)
		mocks.log.warn.mockResolvedValue(undefined)
		mocks.compoundSubscribeToList.mockResolvedValue({
			id: 42,
			email_address: 'reader@example.com',
			state: 'active',
			fields: { dynamic_answer_2026: 'yes' },
			tags: [{ id: 7 }],
		})
		mocks.subscribeToEndpoint.mockResolvedValue({
			id: '42',
			fields: {},
		})
	})

	it('preserves Course Builder field creation and write behavior', async () => {
		await expect(
			emailListProvider.subscribeToList(formOptions),
		).resolves.toEqual(
			expect.objectContaining({
				id: 42,
				fields: { dynamic_answer_2026: 'yes' },
				tags: [{ id: 7 }],
			}),
		)

		expect(mocks.compoundSubscribeToList).toHaveBeenCalledTimes(1)
		expect(mocks.compoundSubscribeToList).toHaveBeenCalledWith(formOptions)
		expect(mocks.subscribeToEndpoint).not.toHaveBeenCalled()
	})

	it('maps a direct 429 to a stable real-handler boundary error', async () => {
		mocks.compoundSubscribeToList.mockRejectedValue(kitError(429))

		await expect(
			emailListProvider.subscribeToList(formOptions),
		).rejects.toEqual(
			expect.objectContaining({
				name: 'KitSubscribeError',
				code: 'rate-limited',
				status: 429,
				message: `${KIT_SUBSCRIBE_FAILURE_PREFIX}rate-limited:429`,
			}),
		)
		expect(mocks.compoundSubscribeToList).toHaveBeenCalledTimes(1)
		expect(mocks.subscribeToEndpoint).not.toHaveBeenCalled()
	})

	it('rejects an unresolved full-provider subscriber identity', async () => {
		mocks.compoundSubscribeToList.mockResolvedValue({
			id: 42,
			email_address: 'other@example.com',
			fields: { dynamic_answer_2026: 'yes' },
		})

		await expect(
			emailListProvider.subscribeToList(formOptions),
		).rejects.toEqual(
			expect.objectContaining<Partial<KitSubscribeError>>({
				code: 'unresolved',
			}),
		)
	})
})

describe('subscribeToKitListWithoutFields', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.subscribeToEndpoint.mockResolvedValue({ id: '42', fields: {} })
	})

	it.each([
		['sequence', '2625552', '/sequences/2625552/subscribe'],
		['tag', '22309615', '/tags/22309615/subscribe'],
	] as const)(
		'uses one lean %s POST with no field contract',
		async (listType, listId, endPoint) => {
			await expect(
				subscribeToKitListWithoutFields({ listType, listId, user }),
			).resolves.toEqual({
				id: 42,
				email_address: 'reader@example.com',
				fields: {},
			})

			expect(mocks.subscribeToEndpoint).toHaveBeenCalledTimes(1)
			expect(mocks.subscribeToEndpoint).toHaveBeenCalledWith({
				endPoint,
				params: {
					email: 'reader@example.com',
					first_name: 'Reader',
				},
				convertkitApiKey: 'test-api-key',
			})
			expect(mocks.compoundSubscribeToList).not.toHaveBeenCalled()
		},
	)

	it('does not report requested fields as confirmed', async () => {
		const unsafeOptions = {
			listType: 'tag',
			listId: '22309615',
			user,
			fields: { dynamic_answer_2026: 'yes' },
		} as unknown as Parameters<typeof subscribeToKitListWithoutFields>[0]

		await expect(
			subscribeToKitListWithoutFields(unsafeOptions),
		).rejects.toEqual(
			expect.objectContaining<Partial<KitSubscribeError>>({
				code: 'unresolved',
			}),
		)
		expect(mocks.subscribeToEndpoint).not.toHaveBeenCalled()
	})

	it.each(['sequence', 'tag'] as const)(
		'rejects a present mismatched email from a lean %s response',
		async (listType) => {
			mocks.subscribeToEndpoint.mockResolvedValue({
				id: '42',
				email_address: 'other@example.com',
				fields: {},
			})

			await expect(
				subscribeToKitListWithoutFields({
					listType,
					listId: '123',
					user,
				}),
			).rejects.toEqual(
				expect.objectContaining<Partial<KitSubscribeError>>({
					code: 'unresolved',
				}),
			)
		},
	)

	it.each(['9007199254740992', Number.MAX_SAFE_INTEGER + 1, 1.5])(
		'rejects unsafe subscriber id %s',
		async (id) => {
			mocks.subscribeToEndpoint.mockResolvedValue({ id, fields: {} })

			await expect(
				subscribeToKitListWithoutFields({
					listType: 'tag',
					listId: '22309615',
					user,
				}),
			).rejects.toEqual(
				expect.objectContaining<Partial<KitSubscribeError>>({
					code: 'unresolved',
				}),
			)
		},
	)
})
