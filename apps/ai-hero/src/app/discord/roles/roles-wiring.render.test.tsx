// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, any>,
	sync: vi.fn(),
	refresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({
	redirect: vi.fn(),
	useRouter: () => ({ refresh: mocks.refresh }),
}))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.test' },
}))
vi.mock('@/components/brand/icons', () => ({ Icon: () => null }))
vi.mock('@/components/layout-client', () => ({
	default: ({ children }: any) => <>{children}</>,
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: async () => ({ session: { user: { id: 'u1' } } }),
}))
vi.mock('@coursebuilder/ui', () => ({
	Button: ({ children, asChild: _a, ...props }: any) => (
		<span {...props}>{children}</span>
	),
}))
vi.mock('./actions', () => ({
	getDiscordRoleState: async () => mocks.state,
	syncDiscordRoles: (...args: unknown[]) => mocks.sync(...args),
}))

import DiscordRolesPage from './page'
import { SyncRolesButton } from './sync-button'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(async () => {
	await act(async () => root?.unmount())
	root = null
	vi.clearAllMocks()
})

async function renderNode(node: React.ReactNode) {
	const host = document.createElement('div')
	document.body.appendChild(host)
	await act(async () => {
		root = createRoot(host)
		root.render(node)
	})
	return host
}

const roles = (assigned: boolean[]) =>
	assigned.map((a, i) => ({
		roleId: `r${i}`,
		roleName: `Role ${i}`,
		roleColor: '#5865F2',
		source: 'Purchase',
		sourceType: 't',
		assigned: a,
	}))

describe('roles page wiring: Sync renders only for needs-sync', () => {
	const cases: [string, Record<string, any>, boolean][] = [
		[
			'member, unassigned role',
			{ memberFetch: 'member', roles: roles([false]) },
			true,
		],
		[
			'member, all assigned',
			{ memberFetch: 'member', roles: roles([true]) },
			false,
		],
		[
			'not in the server',
			{ memberFetch: 'not-member', roles: roles([false]) },
			false,
		],
		['lookup failed', { memberFetch: 'error', roles: roles([false]) }, false],
		['member, no entitlements', { memberFetch: 'member', roles: [] }, false],
	]
	it.each(cases)('%s', async (_name, state, expectSync) => {
		mocks.state = { connected: true, discordUsername: 'u', ...state }
		const host = await renderNode(await DiscordRolesPage())
		expect(host.textContent?.includes('Sync My Roles')).toBe(expectSync)
	})

	it('not-in-server points to /discord to join', async () => {
		mocks.state = {
			connected: true,
			memberFetch: 'not-member',
			roles: roles([false]),
		}
		const host = await renderNode(await DiscordRolesPage())
		expect(host.querySelector('a[href="/discord"]')).not.toBeNull()
	})
})

describe('SyncRolesButton result', () => {
	const click = async (host: HTMLElement) =>
		act(async () => {
			host
				.querySelector('button')!
				.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		})

	it('a failed sync keeps its error visible and does not refresh', async () => {
		mocks.sync.mockResolvedValue({
			success: false,
			synced: 0,
			error: 'Discord API error (500)',
		})
		const host = await renderNode(<SyncRolesButton />)
		await click(host)
		expect(host.textContent).toContain('Discord API error (500)')
		expect(mocks.refresh).not.toHaveBeenCalled()
	})

	it('a successful sync shows its count and refreshes', async () => {
		mocks.sync.mockResolvedValue({ success: true, synced: 2 })
		const host = await renderNode(<SyncRolesButton />)
		await click(host)
		expect(host.textContent).toContain('2 roles synced')
		expect(mocks.refresh).toHaveBeenCalled()
	})
})
