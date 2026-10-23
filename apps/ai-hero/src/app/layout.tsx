import '@/styles/globals.css'

import * as React from 'react'
import { Metadata } from 'next'
import { DM_Sans, JetBrains_Mono, Source_Serif_4 } from 'next/font/google'
import Script from 'next/script'
import { FeedbackInsert } from '@/components/feedback-widget/feedback-insert'
import { FirstTouchCapture } from '@/components/first-touch-capture'
import { GuardedCouponProvider } from '@/components/guarded-coupon-provider'
import { Party } from '@/components/party'
import { Providers } from '@/components/providers'
import { ThemeProvider } from '@/components/theme-provider'
import config from '@/config'
import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { getProduct } from '@/lib/products-query'
import { getNextOfferSafe } from '@/lib/next-offer'
import { SiteStructuredData } from '@/lib/structured-data'
import { NavCtaProvider } from '@/components/navigation/nav-cta-context'
import { PromoBar } from '@/components/navigation/promo-bar'
import { PromoBarSlot } from '@/components/navigation/promo-bar-slot'
import { PlaybackPrefHydrator } from '@/hooks/playback-pref-hydrator'
import { TRPCReactProvider } from '@/trpc/react'
import { ourFileRouter } from '@/uploadthing/core'
import { NextSSRPlugin } from '@uploadthing/react/next-ssr-plugin'
import HolyLoader from 'holy-loader'
import { AxiomWebVitals } from 'next-axiom'
import { NuqsAdapter } from 'nuqs/adapters/next/app'
import { extractRouterConfig } from 'uploadthing/server'

import { getCouponForCode } from '@coursebuilder/commerce/props-for-commerce'
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
	// Testimonials only, and they sit below the fold where they appear at all.
	// Preloading put two serif files (~100KB) at highest priority on every page.
	preload: false,
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

/**
 * How long after `load` the Google tag loads when the reader has not touched
 * the page. See the comment on the init script below.
 */
const GTAG_DELAY_MS = 5000

/** GA4 measurement id first, then the Ads id, minus whatever is unset. */
const gtagIds =
	env.NODE_ENV === 'development'
		? []
		: [env.NEXT_PUBLIC_GOOGLE_ANALYTICS, env.NEXT_PUBLIC_GOOGLE_ADS_ID].filter(
				(id): id is string => Boolean(id),
			)

export default async function RootLayout({
	children,
}: {
	children: React.ReactNode
}) {
	// NOT awaited. This is the ROOT layout — an await here holds the `html` tag
	// itself, so every route on the site would wait on one cached DB read before
	// a single byte streamed, to decide whether a nav button and an announcement
	// bar appear. The promise crosses into `NavCtaProvider`, and the two
	// components that read it unwrap it under their own Suspense.
	//
	// `…Safe` because a rejection here lands above every error boundary and would
	// replace the whole site with the global error page rather than dropping one
	// CTA; it resolves to `null` instead. See `nav-cta.ts`.
	const cohortOffer = getNextOfferSafe()

	return (
		<Providers>
			<html lang="en" suppressHydrationWarning>
				<head>
					{process.env.NODE_ENV === 'development' && (
						<>
						<Script
							src="//unpkg.com/react-grab/dist/index.global.js"
							crossOrigin="anonymous"
							strategy="beforeInteractive"
						/>
						{/* <Script
							src="http://127.0.0.1:43127/agent-feedback.js"
							crossOrigin="anonymous"
							strategy="beforeInteractive"
						/> */}
						</>
					)}
				</head>
				<AxiomWebVitals />
				<body
					id="layout"
					className={`bg-page-background relative overflow-x-hidden ${geist.variable} ${geistMono.variable} ${sourceSerif.variable} antialiased font-sans`}
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
						<PlaybackPrefHydrator />
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
								<GuardedCouponProvider
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
										{/* The bar resolves its own promo and suspends while it
										    does; the fallback is its exact height so nothing
										    below it moves when the row arrives. */}
										<PromoBarSlot>
											<React.Suspense
												fallback={<div className="h-[34px] print:hidden" />}
											>
												<PromoBar />
											</React.Suspense>
										</PromoBarSlot>
										{children}
									</NavCtaProvider>
								</GuardedCouponProvider>
							</ThemeProvider>
						</NuqsAdapter>
					</TRPCReactProvider>
					{/* One gtag.js for both Google products, loaded after `load`.

					    The GA and Ads tags used to be two `afterInteractive`
					    `<Script src>`s. The App Router preloads those from the
					    document head, so ~330KB of tag JS was fetched at high
					    priority at ~0.5s, ahead of every one of the app's own
					    chunks. (gtag fetches the Ads container itself once it sees
					    the second `config`, so the byte count is the same; what
					    changes is when it competes.)

					    NOT `strategy="lazyOnload"`: that waits on
					    `requestIdleCallback`, and the hero shader's rAF loop can
					    starve idle callbacks indefinitely — on `/` and `/newsletter`
					    the tag never loaded at all in testing. This inline script
					    is never preloaded and runs after hydration.

					    It appends the tag on the reader's first interaction
					    (scroll, touch, pointer, key) or ${GTAG_DELAY_MS / 1000}s
					    after `load`, whichever comes first. The tag's own
					    evaluation is ~500ms of main thread on a mid-range phone,
					    and running it inside the page's loading window was most
					    of what was left of the homepage's blocking time. Someone
					    who leaves within ${GTAG_DELAY_MS / 1000}s without touching
					    the page is the only visit this does not record; every
					    event on a later page still fires, since the tag is loaded
					    by then. The hits themselves are unchanged. */}
					{gtagIds.length > 0 && (
						<Script id="gtag-init" strategy="afterInteractive">
							{`
								window.dataLayer = window.dataLayer || [];
								function gtag(){window.dataLayer.push(arguments);}
								gtag('js', new Date());
								${gtagIds.map((id) => `gtag('config', '${id}');`).join('\n')}
								(function () {
									var done = false;
									var events = ['scroll', 'touchstart', 'pointerdown', 'pointermove', 'keydown'];
									var load = function () {
										if (done) return;
										done = true;
										events.forEach(function (e) { window.removeEventListener(e, load); });
										var s = document.createElement('script');
										s.async = true;
										s.src = 'https://www.googletagmanager.com/gtag/js?id=${gtagIds[0]}';
										document.head.appendChild(s);
									};
									events.forEach(function (e) { window.addEventListener(e, load, { passive: true }); });
									var arm = function () { setTimeout(load, ${GTAG_DELAY_MS}); };
									if (document.readyState === 'complete') arm();
									else window.addEventListener('load', arm, { once: true });
								})();
							`}
						</Script>
					)}
				</body>
			</html>
		</Providers>
	)
}
