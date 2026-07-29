import '@/styles/globals.css'

import * as React from 'react'
import { Metadata } from 'next'
import { DM_Sans, JetBrains_Mono, Source_Serif_4 } from 'next/font/google'
import Script from 'next/script'
import { FeedbackInsert } from '@/components/feedback-widget/feedback-insert'
import { FirstTouchCapture } from '@/components/first-touch-capture'
import { Party } from '@/components/party'
import { Providers } from '@/components/providers'
import { ThemeProvider } from '@/components/theme-provider'
import config from '@/config'
import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { getProduct } from '@/lib/products-query'
import { getCohortOfferSafe } from '@/lib/nav-cta'
import { SiteStructuredData } from '@/lib/structured-data'
import { NavCtaProvider } from '@/components/navigation/nav-cta-context'
import { PromoBar } from '@/components/navigation/promo-bar'
import { PromoBarSlot } from '@/components/navigation/promo-bar-slot'
import { TRPCReactProvider } from '@/trpc/react'
import { ourFileRouter } from '@/uploadthing/core'
import { GoogleAnalytics } from '@next/third-parties/google'
import { NextSSRPlugin } from '@uploadthing/react/next-ssr-plugin'
import HolyLoader from 'holy-loader'
import { AxiomWebVitals } from 'next-axiom'
import { NuqsAdapter } from 'nuqs/adapters/next/app'
import { extractRouterConfig } from 'uploadthing/server'

import { CouponProvider } from '@coursebuilder/commerce-next/coupons/coupon-context'
import { getCouponForCode } from '@coursebuilder/core/pricing/props-for-commerce'
import { Toaster } from '@coursebuilder/ui/primitives/toaster'

/**
 * DM Sans + JetBrains Mono, per the redesign's token spec (`aihero.css`).
 * The CSS variables keep their `--font-geist*` names so the hundreds of
 * existing `font-sans` / `font-mono` call sites and the `@theme` mapping keep
 * working — the families behind them are what changed, not the plumbing.
 */
const geist = DM_Sans({
	subsets: ['latin'],
	variable: '--font-geist',
	weight: ['400', '500', '600', '700'],
	style: ['normal', 'italic'],
})

const geistMono = JetBrains_Mono({
	subsets: ['latin'],
	variable: '--font-geist-mono',
	weight: ['400', '500'],
})

/**
 * Source Serif 4 — testimonials only. A quote set in the same DM Sans as the
 * page around it has to lean on italics and quote marks to read as someone
 * else talking; a serif does that on its own. Variable optical sizing means
 * the one face holds up at both the full-width pull quote and the small grid
 * cells, and its stems survive the dark background better than a display
 * serif would.
 */
const sourceSerif = Source_Serif_4({
	subsets: ['latin'],
	variable: '--font-source-serif',
	weight: ['400', '600'],
	style: ['normal', 'italic'],
})

export const metadata: Metadata = {
	metadataBase: new URL(env.NEXT_PUBLIC_URL),
	title: `${config.defaultTitle} by ${config.author}`,
	description: config.description,
	icons: [
		{ rel: 'icon', sizes: 'any', url: '/favicon.ico' },
		{ rel: 'icon', type: 'image/svg+xml', url: '/favicon.svg' },
	],
	twitter: {
		card: 'summary_large_image',
	},
	openGraph: {
		images: [
			{
				url: config.openGraph.images[0]!.url,
			},
		],
	},
}

const isGoogleAnalyticsAvailable =
	env.NODE_ENV !== 'development' && env.NEXT_PUBLIC_GOOGLE_ANALYTICS

const isGoogleAdsAvailable =
	env.NODE_ENV !== 'development' && env.NEXT_PUBLIC_GOOGLE_ADS_ID

export default async function RootLayout({
	children,
}: {
	children: React.ReactNode
}) {
	// Safe to await here: `getCohortOffer` is a cached DB read with no
	// `cookies()` / `headers()`, so it does not opt the tree out of static
	// rendering. Anything viewer-specific stays on the client.
	//
	// `…Safe` because this is the ROOT layout: it renders above every page and
	// above every error boundary, so a throw here replaces the whole site with
	// the global error page rather than dropping one CTA. See `nav-cta.ts`.
	const cohortOffer = await getCohortOfferSafe()

	return (
		<Providers>
			<html lang="en" suppressHydrationWarning>
				<head>
					{process.env.NODE_ENV === 'development' && (
						<Script
							src="//unpkg.com/react-grab/dist/index.global.js"
							crossOrigin="anonymous"
							strategy="beforeInteractive"
						/>
					)}
				</head>
				<AxiomWebVitals />
				<body
					id="layout"
					className={`bg-page-background relative overflow-x-hidden ${geist.variable} ${geistMono.variable} ${sourceSerif.variable} antialised font-sans`}
				>
					<SiteStructuredData />
					<React.Suspense fallback={null}>
						<FirstTouchCapture />
					</React.Suspense>
					<Toaster
						className="[&_button]:opacity-100 [&_svg]:opacity-100"
						viewportClassName="left-auto bottom-0 sm:bottom-5"
					/>
					<FeedbackInsert />
					<TRPCReactProvider>
						<NuqsAdapter>
							<Party />
							<ThemeProvider
								attribute="class"
								defaultTheme="system"
								enableSystem={true}
								disableTransitionOnChange
							>
								<HolyLoader height="0.15rem" speed={250} />
								<NextSSRPlugin
									/**
									 * The `extractRouterConfig` will extract **only** the route configs from the
									 * router to prevent additional information from being leaked to the client. The
									 * data passed to the client is the same as if you were to fetch
									 * `/api/uploadthing` directly.
									 */
									routerConfig={extractRouterConfig(ourFileRouter)}
								/>
								<CouponProvider
									getCouponForCode={async (couponCodeOrId: string | null) => {
										'use server'
										return getCouponForCode(
											couponCodeOrId,
											[],
											courseBuilderAdapter,
										)
									}}
									getProduct={getProduct}
								>
									<NavCtaProvider value={cohortOffer}>
										<PromoBarSlot>
											<PromoBar />
										</PromoBarSlot>
										{children}
									</NavCtaProvider>
								</CouponProvider>
							</ThemeProvider>
						</NuqsAdapter>
					</TRPCReactProvider>
					{isGoogleAnalyticsAvailable && (
						<GoogleAnalytics gaId={env.NEXT_PUBLIC_GOOGLE_ANALYTICS!} />
					)}
					{isGoogleAdsAvailable && (
						<>
							<Script
								src={`https://www.googletagmanager.com/gtag/js?id=${env.NEXT_PUBLIC_GOOGLE_ADS_ID}`}
								strategy="afterInteractive"
							/>
							<Script id="google-ads-remarketing" strategy="afterInteractive">
								{`
									window.dataLayer = window.dataLayer || [];
									function gtag(){window.dataLayer.push(arguments);}
									gtag('js', new Date());
									gtag('config', '${env.NEXT_PUBLIC_GOOGLE_ADS_ID}');
								`}
							</Script>
						</>
					)}
				</body>
			</html>
		</Providers>
	)
}
