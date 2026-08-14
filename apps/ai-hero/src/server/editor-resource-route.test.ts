import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
	getUserAbilityForRequest: vi.fn(),
	log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.getUserAbilityForRequest,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import {
	canAccessEditorResource,
	type EditorResourceRecord,
} from '@/lib/editor-resource'
import { authenticateEditorResourceRequest } from './editor-resource-route'

const request = (authorization?: string) =>
	new NextRequest('http://localhost:3000/api/editor/resources', {
		headers: authorization ? { Authorization: authorization } : {},
	})

const user = { id: 'user_editor', email: 'editor@example.com', roles: [] }
const ability = { can: vi.fn(() => false) }

beforeEach(() => {
	vi.clearAllMocks()
})

describe('editor resource route authentication', () => {
	it('requires the Bearer scheme before device-token lookup', async () => {
		for (const authorization of [
			undefined,
			'device-token',
			'Basic device-token',
		]) {
			const result = await authenticateEditorResourceRequest(
				request(authorization),
			)
			expect(!result.ok && result.response.status).toBe(401)
		}
		expect(mocks.getUserAbilityForRequest).not.toHaveBeenCalled()
	})

	it('accepts an active AI Hero DeviceAccessToken identity without a global contributor role', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user,
			ability,
			authMethod: 'device-token',
		})

		const result = await authenticateEditorResourceRequest(
			request('Bearer device-token'),
		)
		expect(result).toMatchObject({
			context: { userId: user.id, isAdmin: false },
			user,
		})
		expect(result.ok && result.context.canManageResource).toEqual(
			expect.any(Function),
		)
	})

	it('combines an analytics-issued device token with an active editor contribution', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: { ...user, roles: [{ name: 'analytics_viewer' }] },
			ability,
			authMethod: 'device-token',
		})
		const result = await authenticateEditorResourceRequest(
			request('Bearer analytics-issued-device-token'),
		)
		const assigned: EditorResourceRecord = {
			id: 'workshop_1',
			type: 'workshop',
			createdById: 'someone_else',
			fields: { title: 'Crash Course' },
			currentVersionId: null,
			createdAt: new Date(),
			updatedAt: new Date(),
			deletedAt: null,
			organizationId: null,
			createdByOrganizationMembershipId: null,
			contributions: [
				{
					userId: user.id,
					active: true,
					deletedAt: null,
					contributionType: {
						slug: 'editor',
						active: true,
						deletedAt: null,
					},
				},
			],
		}

		expect(result.ok).toBe(true)
		expect(result.ok && canAccessEditorResource(assigned, result.context)).toBe(
			true,
		)
		expect(ability.can).toHaveBeenCalledWith('manage', 'all')
	})

	it('rejects workspace-wide PAT identities on the collaborator API', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user,
			ability,
			authMethod: 'personal-access-token',
		})

		const result = await authenticateEditorResourceRequest(
			request('Bearer aih_pat_example'),
		)
		expect(!result.ok && result.response.status).toBe(403)
	})
})
