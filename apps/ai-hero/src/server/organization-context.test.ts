const mocks = vi.hoisted(() => ({
	headers: vi.fn(),
	cookies: vi.fn(),
}))

vi.mock('next/headers', () => ({
	headers: mocks.headers,
	cookies: mocks.cookies,
}))

import {
	getCurrentOrganizationId,
	resolveSessionOrganizationId,
} from './organization-context'

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

describe('resolveSessionOrganizationId', () => {
	it('keeps an organization selected by the header or cookie', () => {
		expect(
			resolveSessionOrganizationId('selected-org', [
				{
					active: true,
					name: 'learner',
					organizationId: 'learner-org',
				},
			]),
		).toBe('selected-org')
	})

	it('defaults a fresh browser session to the learner organization', () => {
		expect(
			resolveSessionOrganizationId(null, [
				{
					active: true,
					name: 'owner',
					organizationId: 'owner-org',
				},
				{
					active: true,
					name: 'learner',
					organizationId: 'learner-org',
				},
			]),
		).toBe('learner-org')
	})

	it('leaves the organization empty when no default role exists', () => {
		expect(resolveSessionOrganizationId(null, [])).toBeNull()
	})

	it('ignores global roles without an organization', () => {
		expect(
			resolveSessionOrganizationId(null, [
				{ active: true, name: 'admin', organizationId: null },
			]),
		).toBeNull()
	})
})
