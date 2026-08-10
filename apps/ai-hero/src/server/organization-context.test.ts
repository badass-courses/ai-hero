const mocks = vi.hoisted(() => ({
	headers: vi.fn(),
	cookies: vi.fn(),
}))

vi.mock('next/headers', () => ({
	headers: mocks.headers,
	cookies: mocks.cookies,
}))

import { getCurrentOrganizationId } from './organization-context'

describe('getCurrentOrganizationId', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('prefers the organization header set by the proxy', async () => {
		mocks.headers.mockResolvedValue({
			get: vi.fn(() => 'org-from-header'),
		})

		await expect(getCurrentOrganizationId()).resolves.toBe('org-from-header')
		expect(mocks.cookies).not.toHaveBeenCalled()
	})

	it('falls back to the signed-in user organization cookie', async () => {
		mocks.headers.mockResolvedValue({ get: vi.fn(() => null) })
		mocks.cookies.mockResolvedValue({
			get: vi.fn(() => ({ value: 'org-from-cookie' })),
		})

		await expect(getCurrentOrganizationId()).resolves.toBe('org-from-cookie')
	})

	it('returns null when the request has no organization context', async () => {
		mocks.headers.mockResolvedValue({ get: vi.fn(() => null) })
		mocks.cookies.mockResolvedValue({ get: vi.fn(() => undefined) })

		await expect(getCurrentOrganizationId()).resolves.toBeNull()
	})
})
