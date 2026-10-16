import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ link: vi.fn(), cookie: vi.fn() }))
vi.mock('@/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.link }) }) }) } }))
vi.mock('@/db/schema', () => ({ giftShareLink: { slug: 'slug' } }))
vi.mock('next/headers', () => ({ cookies: async () => ({ set: mocks.cookie }) }))
import { rememberGiftShare } from './gift-attribution'
beforeEach(() => { vi.resetAllMocks() })
describe('copied gift share attribution', () => {
  it('sets only the attribution cookie for a verified mapping', async () => {
    mocks.link.mockResolvedValue([{ slug: 'test-link' }])
    expect(await rememberGiftShare('test-link')).toBe(true)
    expect(mocks.cookie).toHaveBeenCalledTimes(1)
    expect(mocks.cookie).toHaveBeenCalledWith('sl_ref', 'test-link', expect.objectContaining({ httpOnly: true, sameSite: 'lax' }))
  })
  it('ignores invalid or unknown slugs and mapping outages', async () => {
    expect(await rememberGiftShare('bad;cookie')).toBe(false)
    mocks.link.mockResolvedValue([])
    expect(await rememberGiftShare('unknown-link')).toBe(false)
    mocks.link.mockRejectedValue(new Error('database-unavailable'))
    expect(await rememberGiftShare('test-link')).toBe(false)
    expect(mocks.cookie).not.toHaveBeenCalled()
  })
})
