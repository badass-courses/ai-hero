import { describe, it, expect, vi } from 'vitest'
vi.mock('@/db', () => ({ db: {}, acquireDatabaseConnection: vi.fn() }))
vi.mock('@/db/schema', () => ({ giftShareLink: {} }))
vi.mock('./switch-server', () => ({ c5PricingClosed: vi.fn() }))
vi.mock('./server', () => ({ frontDeskData: vi.fn() }))
import { giftShareTitle } from './gift-share'
describe('gift share presentation', () => {
  it('never invents a first name for an approved unnamed legend', () => {
    expect(giftShareTitle(null, true)).toBe('A gift for you')
    expect(giftShareTitle(null, false)).toBe('An AI Hero legend recommends')
  })
  it('uses only the stored first name for a named legend', () => {
    expect(giftShareTitle('Test', true)).toBe('Gift from Test')
    expect(giftShareTitle('Test', false)).toBe('Test recommends')
  })
})
