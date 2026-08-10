const { getCouponForCode } = vi.hoisted(() => ({
	getCouponForCode: vi.fn(),
}))

vi.mock('@coursebuilder/core/lib/pricing/props-for-commerce', () => ({
	getCouponForCode,
}))

vi.mock('@/db', () => ({
	courseBuilderAdapter: {},
}))

import { getHomeCouponMetadata } from './metadata'

const DEFAULT_OG_IMAGE =
	'https://res.cloudinary.com/total-typescript/image/upload/v1777557385/og-image-root_2x.jpg'
const GOLDEN_TICKET_OG_IMAGE =
	'https://res.cloudinary.com/total-typescript/image/upload/v1730364326/aihero-golden-ticket_2x_qghsfq.png'

const metadataFor = (searchParams: Record<string, string | undefined>) =>
	getHomeCouponMetadata({ searchParams: Promise.resolve(searchParams) })

describe('home coupon metadata', () => {
	beforeEach(() => {
		getCouponForCode.mockReset()
	})

	it('uses the golden-ticket image for a valid coupon', async () => {
		getCouponForCode.mockResolvedValue({ isValid: true })

		const metadata = await metadataFor({ code: 'VALID' })

		expect(metadata.openGraph).toMatchObject({
			images: [{ url: GOLDEN_TICKET_OG_IMAGE }],
		})
		expect(metadata.alternates).toEqual({ canonical: '/' })
		expect(metadata.robots).toMatchObject({ index: false })
	})

	it('uses the default image for an invalid coupon', async () => {
		getCouponForCode.mockResolvedValue({ isValid: false })

		const metadata = await metadataFor({ coupon: 'INVALID' })

		expect(metadata.openGraph).toMatchObject({
			images: [{ url: DEFAULT_OG_IMAGE }],
		})
	})

	it('uses the default image when no coupon parameter is present', async () => {
		const metadata = await metadataFor({})

		expect(metadata.openGraph).toMatchObject({
			images: [{ url: DEFAULT_OG_IMAGE }],
		})
		expect(getCouponForCode).not.toHaveBeenCalled()
	})
})
