import { expect, it, vi } from 'vitest'

vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))

import { appRouter } from './root'

it('does not register an image inventory router', () => {
	expect(appRouter).not.toHaveProperty('imageResources')
})

it('does not register an unrestricted list lookup', () => {
	expect(appRouter).not.toHaveProperty('contentResources.getList')
})
