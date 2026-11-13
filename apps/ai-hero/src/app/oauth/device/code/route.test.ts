import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ values: vi.fn(), find: vi.fn() }))
vi.mock('@/db', () => ({
	db: {
		insert: () => ({ values: mocks.values }),
		query: { deviceVerifications: { findFirst: mocks.find } },
	},
}))
vi.mock('@/db/schema', () => ({
	deviceVerifications: { deviceCode: Symbol('deviceCode') },
}))
import { deviceGrantFromCode } from '@/server/device-token-grant'
import { POST } from './route'
const start = (fields?: Record<string, string>) =>
	POST(
		new Request('https://aihero.test/oauth/device/code', {
			method: 'POST',
			body: fields ? new URLSearchParams(fields) : undefined,
		}),
	)
beforeEach(() => {
	vi.clearAllMocks()
	mocks.find.mockImplementation(async () => mocks.values.mock.calls[0]?.[0])
})
describe('device authorization', () => {
	it.each([undefined, { client_id: 'unknown' }, { client_id: 'aihero-cli' }])(
		'defaults %j to learner-only with a stored client binding',
		async (fields) => {
			const response = await start(fields)
			expect(response.status).toBe(200)
			const body = await response.json()
			expect(deviceGrantFromCode(body.device_code)).toMatchObject({
				scope: 'learner:read',
				clientName:
					fields?.client_id === 'aihero-cli' ? 'aihero-cli' : 'learner-device',
			})
		},
	)
	it('binds an explicit privileged request for the known CLI for approval', async () => {
		const response = await start({
			client_id: 'aihero-cli',
			scope: 'admin:all',
		})
		expect(deviceGrantFromCode((await response.json()).device_code)).toEqual({
			clientName: 'aihero-cli',
			scope: 'admin:all',
		})
	})
	it.each<Record<string, string>>([{}, { client_id: 'unknown' }])(
		'refuses privileged requests without the known client: %j',
		async (fields) => {
			expect((await start({ ...fields, scope: 'admin:all' })).status).toBe(400)
			expect(mocks.values).not.toHaveBeenCalled()
		},
	)
})
