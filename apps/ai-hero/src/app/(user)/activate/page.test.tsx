import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ session: vi.fn(), find: vi.fn() }))
vi.mock('@/db', () => ({
	db: { query: { deviceVerifications: { findFirst: mocks.find } } },
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.session }))
vi.mock('@/components/layout-client', () => ({ default: () => null }))
vi.mock('./_components/verifiy', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
	redirect: (url: string) => {
		throw new Error(`redirect:${url}`)
	},
}))
import {
	matchesDeviceConsent,
	mintDeviceCode,
} from '@/server/device-token-grant'
import Activate from './page'
let deviceCode: string
beforeEach(() => {
	vi.clearAllMocks()
	deviceCode = mintDeviceCode({ clientName: 'aihero-cli', scope: 'admin:all' })!
	mocks.session.mockResolvedValue({ session: { user: { id: 'u1' } } })
	mocks.find.mockResolvedValue({
		deviceCode,
		expires: new Date(Date.now() + 60_000),
	})
})
describe('device approval page', () => {
	it('never passes the device polling secret to browser props', async () => {
		const page = await Activate({
			searchParams: Promise.resolve({ user_code: 'test-code' }),
		})
		const props = page.props.children.props
		expect(JSON.stringify(props)).not.toContain('aih_dev_')
		expect(JSON.stringify(props)).not.toContain(deviceCode)
		expect(props).not.toHaveProperty('deviceCode')
		expect(props).toMatchObject({
			userCode: 'test-code',
			clientName: 'aihero-cli',
			scope: 'admin:all',
			consent: expect.any(String),
		})
		expect(
			matchesDeviceConsent(props.consent, 'test-code', deviceCode, 'u1'),
		).toBe(true)
		expect(
			matchesDeviceConsent(
				props.consent,
				'test-code',
				deviceCode,
				'other-user',
			),
		).toBe(false)
	})
})
