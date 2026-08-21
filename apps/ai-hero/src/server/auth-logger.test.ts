import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}))

vi.mock('@/server/logger', () => ({ log: mocks }))

import { authLogger } from './auth-logger'

const ALL_UNKNOWN_LOG_DATA = {
	authErrorType: 'unknown',
	authErrorKind: 'unknown',
	authCauseType: 'unknown',
	authCauseCategory: 'unknown',
	authCauseCode: 'unknown',
	authFailureKind: 'unknown-failure',
	provider: 'unknown',
}

const authSource = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8')

describe('configured Auth.js logger boundary', () => {
	beforeEach(() => {
		mocks.info.mockReset()
		mocks.warn.mockReset()
		mocks.error.mockReset()
	})

	it('is the logger object configured by authOptions', () => {
		expect(authSource).toContain('logger: authLogger')
	})

	it('does not let hostile values escape or replace the safe redirect', () => {
		const cases: Array<{ label: string; trapText: string; value: unknown }> = []

		const prototypeTrapText =
			'PRIVATE_PROXY_PROTOTYPE_TRAP customer@example.com'
		cases.push({
			label: 'Proxy getPrototypeOf trap',
			trapText: prototypeTrapText,
			value: {
				type: 'AdapterError',
				cause: {
					err: new Proxy(
						{},
						{
							getPrototypeOf: () => {
								throw new Error(prototypeTrapText)
							},
						},
					),
				},
			},
		})

		const getterTrapText = 'PRIVATE_PROXY_GET_TRAP Bearer private-token'
		cases.push({
			label: 'Proxy property getter',
			trapText: getterTrapText,
			value: {
				type: 'AdapterError',
				cause: {
					err: new Proxy(
						{},
						{
							get: () => {
								throw new Error(getterTrapText)
							},
						},
					),
				},
			},
		})

		const ordinaryGetterText = 'PRIVATE_GETTER_TRAP account_987654'
		cases.push({
			label: 'ordinary throwing getter',
			trapText: ordinaryGetterText,
			value: Object.defineProperty({}, 'type', {
				get: () => {
					throw new Error(ordinaryGetterText)
				},
			}),
		})

		const customPrototypeText =
			'PRIVATE_CUSTOM_PROTOTYPE_TRAP https://private.example'
		const hostilePrototype = new Proxy(
			{},
			{
				getPrototypeOf: () => {
					throw new Error(customPrototypeText)
				},
			},
		)
		cases.push({
			label: 'hostile custom prototype chain',
			trapText: customPrototypeText,
			value: {
				type: 'AdapterError',
				cause: { err: Object.create(hostilePrototype) },
			},
		})

		cases.push({
			label: 'thrown primitive',
			trapText: 'PRIVATE_PRIMITIVE_TEXT customer@example.com',
			value: 'PRIVATE_PRIMITIVE_TEXT customer@example.com',
		})

		for (const testCase of cases) {
			mocks.error.mockClear()
			let redirect = ''

			expect(() => {
				authLogger.error(testCase.value)
				redirect = '/error?error=Configuration'
			}).not.toThrow()

			expect(redirect, testCase.label).toBe('/error?error=Configuration')
			expect(mocks.error, testCase.label).toHaveBeenCalledWith(
				'auth.nextauth.error',
				ALL_UNKNOWN_LOG_DATA,
			)
			const logged = JSON.stringify(mocks.error.mock.calls)
			expect(logged, testCase.label).not.toContain(testCase.trapText)
			expect(redirect, testCase.label).not.toContain(testCase.trapText)
		}
	})

	it('swallows synchronous log sink throws', () => {
		const sinkText = 'PRIVATE_SYNC_SINK_FAILURE customer@example.com'
		mocks.error.mockImplementation(() => {
			throw new Error(sinkText)
		})

		expect(() =>
			authLogger.error({ type: 'AdapterError', cause: { err: new Error() } }),
		).not.toThrow()
		expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(sinkText)
	})

	it('sinks rejected promises from every configured logger callback', async () => {
		mocks.info.mockRejectedValue(new Error('PRIVATE_INFO_REJECTION'))
		mocks.warn.mockRejectedValue(new Error('PRIVATE_WARN_REJECTION'))
		mocks.error.mockRejectedValue(new Error('PRIVATE_ERROR_REJECTION'))

		expect(() => authLogger.error({ type: 'AdapterError' })).not.toThrow()
		expect(() => authLogger.warn('csrf-disabled')).not.toThrow()
		expect(() =>
			authLogger.debug('OAuthCallbackError', {
				providerId: 'github',
				error: 'server_error',
			}),
		).not.toThrow()

		await Promise.resolve()
		await Promise.resolve()

		expect(mocks.error).toHaveBeenCalled()
		expect(mocks.warn).toHaveBeenCalled()
	})

	it('sinks a hostile thenable returned by the log sink', async () => {
		const trapText = 'PRIVATE_THENABLE_TRAP customer@example.com'
		const thenable = Object.defineProperty({}, 'then', {
			get: () => {
				throw new Error(trapText)
			},
		})
		mocks.error.mockReturnValue(thenable)

		expect(() => authLogger.error({ type: 'AdapterError' })).not.toThrow()
		await Promise.resolve()
		await Promise.resolve()

		expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(trapText)
	})

	it('fails closed when OAuth debug metadata getters throw', () => {
		const trapText = 'PRIVATE_DEBUG_GETTER customer@example.com'
		const metadata = new Proxy(
			{},
			{
				get: () => {
					throw new Error(trapText)
				},
			},
		)

		expect(() => authLogger.debug('OAuthCallbackError', metadata)).not.toThrow()
		expect(mocks.error).toHaveBeenCalledWith('auth.nextauth.oauth_callback', {
			authFailureKind: 'unknown-oauth-failure',
			oauthResultCode: 'unknown',
			provider: 'unknown',
		})
		expect(JSON.stringify(mocks.error.mock.calls)).not.toContain(trapText)
	})
})
