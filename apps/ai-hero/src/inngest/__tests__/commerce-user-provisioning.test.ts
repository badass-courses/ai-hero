import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	membership: false,
	organization: null as { id: string; name: string } | null,
	roles: [] as string[],
	organizationsCreated: 0,
	isNewUser: true,
	failProvisioning: false,
	send: vi.fn(async () => ({ ids: ['repair-event'] })),
	middlewareOptions: null as unknown as {
		db: { findOrCreateUser: (email: string) => Promise<unknown> }
	},
}))

// Only the persistence and event/provider boundaries are replaced. The app
// identity helper, provisioning boundary and personal-org policy run for real.
vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		findOrCreateUser: async (email: string) => ({
			user: { id: 'synthetic-buyer', email },
			isNewUser: state.isNewUser,
		}),
		getUserById: async () => ({
			id: 'synthetic-buyer',
			email: 'buyer@example.test',
		}),
		getPersonalOrganization: async () => {
			if (state.failProvisioning) throw new Error('synthetic DB failure')
			return state.organization
		},
		createPersonalOrganization: async ({ name }: { name: string }) => {
			state.organizationsCreated += 1
			state.organization = { id: 'synthetic-organization', name }
			return state.organization
		},
		addMemberToOrganization: async () => {
			state.membership = true
			return {
				id: 'synthetic-membership',
				organizationId: 'synthetic-organization',
			}
		},
		getMembershipsForUser: async () =>
			state.membership
				? [{ id: 'synthetic-membership', organization: state.organization }]
				: [],
		addRoleForMember: async ({ role }: { role: string }) => {
			if (!state.roles.includes(role)) state.roles.push(role)
		},
	},
}))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_APP_NAME: 'synthetic-app' },
}))
vi.mock('@/server/auth', () => ({ authOptions: {} }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), error: vi.fn() },
	serializeError: () => ({ name: 'Error' }),
}))
vi.mock('@/coursebuilder/slack-provider', () => ({ slackProvider: {} }))
vi.mock('@/coursebuilder/stripe-provider', () => ({ stripeProvider: {} }))
vi.mock('uploadthing/server', () => ({ UTApi: class {} }))
vi.mock('@coursebuilder/core/providers/deepgram', () => ({
	default: () => ({}),
}))
vi.mock('@coursebuilder/core/providers/openai', () => ({
	default: () => ({}),
}))
vi.mock('@coursebuilder/core/providers/partykit', () => ({
	default: () => ({}),
}))
vi.mock('@coursebuilder/server/create-inngest-middleware', () => ({
	createInngestMiddleware: (options: typeof state.middlewareOptions) => {
		state.middlewareOptions = options
		return {}
	},
}))
vi.mock('inngest', () => ({
	Inngest: class {
		send = state.send
		createFunction(_config: unknown, _trigger: unknown, handler: unknown) {
			return { handler }
		}
	},
	InngestMiddleware: class {},
	EventSchemas: class {
		fromRecord() {
			return {}
		}
	},
}))

import { courseBuilderAdapter } from '@/db'
import { getManagedOrganizationIds } from '@/lib/team-purchases'
import { ENSURE_PERSONAL_ORGANIZATION_EVENT } from '../events/ensure-personal-organization'
import { ensurePersonalOrganizationWorkflow } from '../functions/ensure-personal-organization'
import '../inngest.server'

type RepairHandler = (input: {
	event: { data: { userId: string } }
	step: {
		run: (id: string, callback: () => Promise<unknown>) => Promise<unknown>
	}
	db: typeof courseBuilderAdapter
}) => Promise<unknown>
const repair = (
	ensurePersonalOrganizationWorkflow as unknown as { handler: RepairHandler }
).handler

function managedOrganizationIds() {
	return getManagedOrganizationIds(
		state.membership
			? [
					{
						organizationId: 'synthetic-organization',
						organizationMembershipRoles: state.roles.map((name) => ({
							active: true,
							deletedAt: null,
							role: { name, active: true, deletedAt: null },
						})),
					},
				]
			: [],
	)
}

describe('commerce workflow identity provisioning', () => {
	beforeEach(() => {
		state.membership = false
		state.organization = null
		state.roles = []
		state.organizationsCreated = 0
		state.isNewUser = true
		state.failProvisioning = false
		state.send.mockReset().mockResolvedValue({ ids: ['repair-event'] })
	})

	it('provisions a new checkout or invoice buyer with manager authority before returning', async () => {
		const result =
			await state.middlewareOptions.db.findOrCreateUser('buyer@example.test')
		expect(result).toMatchObject({
			isNewUser: true,
			user: { id: 'synthetic-buyer' },
		})
		expect(state.membership).toBe(true)
		expect(state.roles).toEqual(['owner'])
		expect(managedOrganizationIds()).toEqual(['synthetic-organization'])
		expect(state.send).not.toHaveBeenCalled()
	})

	it('does not recreate revoked organization authority on an existing buyer or retry', async () => {
		await state.middlewareOptions.db.findOrCreateUser('buyer@example.test')
		state.isNewUser = false
		state.roles = []
		for (let retry = 0; retry < 2; retry++) {
			await state.middlewareOptions.db.findOrCreateUser('buyer@example.test')
		}
		expect(state.organizationsCreated).toBe(1)
		expect(state.roles).toEqual([])
		expect(managedOrganizationIds()).toEqual([])
		expect(state.send).not.toHaveBeenCalled()
	})

	it('does not silently bootstrap an existing memberless buyer', async () => {
		state.isNewUser = false
		await state.middlewareOptions.db.findOrCreateUser('buyer@example.test')
		expect(state.membership).toBe(false)
		expect(state.organizationsCreated).toBe(0)
		expect(state.send).not.toHaveBeenCalled()
	})

	it('hands failure only to the existing org repair workflow, which is retry-safe', async () => {
		state.failProvisioning = true
		await state.middlewareOptions.db.findOrCreateUser('buyer@example.test')
		expect(state.membership).toBe(false)
		expect(state.send).toHaveBeenCalledTimes(1)
		expect(state.send).toHaveBeenCalledWith({
			name: ENSURE_PERSONAL_ORGANIZATION_EVENT,
			data: { userId: 'synthetic-buyer', createIfMissing: true },
		})
		state.failProvisioning = false
		for (let retry = 0; retry < 2; retry++) {
			await repair({
				event: { data: { userId: 'synthetic-buyer' } },
				step: { run: async (_id, callback) => callback() },
				db: courseBuilderAdapter,
			})
		}
		expect(state.organizationsCreated).toBe(1)
		expect(state.membership).toBe(true)
		expect(state.roles).toEqual(['owner', 'learner'])
		expect(managedOrganizationIds()).toEqual(['synthetic-organization'])
		// No purchase/entitlement replay, welcome mail or invite event.
		expect(state.send).toHaveBeenCalledTimes(1)
	})

	it('fails closed when provisioning and durable repair transport both fail', async () => {
		state.failProvisioning = true
		const error = new Error('synthetic repair transport failure')
		state.send.mockRejectedValue(error)
		await expect(
			state.middlewareOptions.db.findOrCreateUser('buyer@example.test'),
		).rejects.toBe(error)
		expect(state.membership).toBe(false)
	})
})
