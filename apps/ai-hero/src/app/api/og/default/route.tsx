import { ImageResponse } from 'next/og'
import { db } from '@/db'
import { coupon, products, purchases } from '@/db/schema'
import { and, count, eq, gte, isNull, or } from 'drizzle-orm'

export const runtime = 'edge'
// Cache headers are set dynamically based on coupon expiry — see below
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		const hasTitle = searchParams.has('title')

		// Get the font for text rendering
		const fontData = await fetch(
			new URL(
				'../../../../../public/fonts/79122e33-d8c9-4b2c-8add-f48bd7b317e0.ttf',
				import.meta.url,
			),
		).then((res) => res.arrayBuffer())

		// Check for global coupon/default coupon by querying db directly
		let discountPercentage = null
		let saleProductName: string | null = null
		let couponExpiresAt: Date | null = null

		try {
			// Pick the highest-discount *active* default coupon
			const now = new Date()
			const globalCoupon = await db.query.coupon.findFirst({
				where: and(
					eq(coupon.default, true), // flagged as default
					eq(coupon.status, 1), // status "active" (matches adapter logic)
					or(isNull(coupon.expires), gte(coupon.expires, now)), // not expired
				),
				orderBy: (coupon, { desc }) => [desc(coupon.percentageDiscount)],
				with: {
					product: true,
				},
			})

			if (globalCoupon?.percentageDiscount) {
				couponExpiresAt = globalCoupon.expires

				// Check if coupon is tied to a product with limited seats
				if (globalCoupon.restrictedToProductId && globalCoupon.product) {
					const product = globalCoupon.product
					// Check if product has limited availability
					if (product.quantityAvailable >= 0) {
						// Count purchases for this product
						const [purchaseCount] = await db
							.select({ count: count() })
							.from(purchases)
							.where(eq(purchases.productId, product.id))

						const availableSeats =
							product.quantityAvailable - (purchaseCount?.count || 0)

						// Don't show coupon if product is sold out
						if (availableSeats <= 0) {
							console.log(
								`Coupon ${globalCoupon.id} tied to sold-out product ${product.id}`,
							)
							couponExpiresAt = null // no sale to cache-bust
						} else {
							discountPercentage = Math.floor(
								Number(globalCoupon.percentageDiscount) * 100,
							)
							saleProductName = product.name
						}
					} else {
						// Unlimited quantity product
						discountPercentage = Math.floor(
							Number(globalCoupon.percentageDiscount) * 100,
						)
						saleProductName = product.name
					}
				} else {
					// No product restriction or product not found
					discountPercentage = Math.floor(
						Number(globalCoupon.percentageDiscount) * 100,
					)
				}
			}
		} catch (error) {
			// Fallback - if coupon query fails, continue without discount
			console.error('Failed to fetch coupon:', error)
		}

		// Title priority: ?title= param > sale product name > generic fallback
		const title = hasTitle
			? searchParams.get('title')
			: saleProductName || 'AI Engineering for Curious Professional Developers'

		// Compute cache TTL: if a sale is active, cache only until it expires
		// (capped at 1 hour so we re-check periodically). No sale = cache 1 hour.
		const MAX_CACHE_SECONDS = 3600 // 1 hour
		const MIN_CACHE_SECONDS = 60 // 1 minute floor
		let cacheSeconds = MAX_CACHE_SECONDS

		if (couponExpiresAt) {
			const secondsUntilExpiry = Math.floor(
				(couponExpiresAt.getTime() - Date.now()) / 1000,
			)
			// Cache until expiry, but clamp between min and max
			cacheSeconds = Math.max(
				MIN_CACHE_SECONDS,
				Math.min(secondsUntilExpiry, MAX_CACHE_SECONDS),
			)
		}

		console.log({
			discountPercentage,
			title,
			saleProductName,
			cacheSeconds,
			couponExpiresAt,
		})

		// Use a background image
		const backgroundImageUrl =
			'https://res.cloudinary.com/total-typescript/image/upload/v1777557351/og-default_2x.jpg'

		const imageResponse = new ImageResponse(
			<div
				tw="flex h-full w-full bg-white flex-col relative"
				style={{
					fontFamily: 'HeadingFont',
					background: '#0D0D0D',
					width: 1200,
					height: 630,
					backgroundImage: `url(${backgroundImageUrl})`,
					backgroundSize: 'cover',
					backgroundPosition: 'center',
				}}
			>
				{/* Main content area */}
				<main tw="flex p-26 pb-32 relative z-10 flex-col w-full h-full grow items-start justify">
					<div tw="flex flex-col items-start">
						<div tw="text-[64px] text-white max-w-[600px] leading-tight mb-4 font-bold">
							{title}
						</div>
						<div tw="text-[36px] text-white/75 max-w-[600px] leading-tight mb-12">
							with Matt Pocock
						</div>

						{discountPercentage ? (
							<div tw="flex items-center justify-center bg-[#FDAEBA] text-black px-10 py-5 rounded-md text-[38px] font-bold">
								<span tw="text-[50px] mr-5">Save {discountPercentage}%</span>{' '}
								for a limited time!
							</div>
						) : (
							<div tw="flex items-center justify-center bg-[#FDAEBA] text-black px-10 py-5 rounded-md text-[38px] font-bold">
								Become an AI developer — fast
							</div>
						)}
					</div>
				</main>
			</div>,
			{
				fonts: [
					{
						name: 'HeadingFont',
						data: fontData,
						style: 'normal',
					},
				],
				debug: false,
				width: 1200,
				height: 630,
			},
		)

		// Set expiry-aware cache headers so Vercel CDN auto-refreshes
		// when a sale ends. No stale sale images after coupon expiry.
		imageResponse.headers.set(
			'Cache-Control',
			`public, s-maxage=${cacheSeconds}, stale-while-revalidate=${MIN_CACHE_SECONDS}`,
		)

		return imageResponse
	} catch (e: any) {
		return new Response('Failed to generate OG image', { status: 500 })
	}
}
