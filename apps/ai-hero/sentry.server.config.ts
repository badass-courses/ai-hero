// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs'
import { scrubCouponTelemetry } from './src/lib/coupon-batches/telemetry'

Sentry.init({
	dsn: 'https://936f0f7cc2484582b9a4ed2b8381248d@o1184810.ingest.sentry.io/6763299',

	// Adjust this value in production, or use tracesSampler for greater control
	tracesSampleRate: 1,
	beforeSend: (event) => scrubCouponTelemetry(event),
	beforeSendTransaction: (event) => scrubCouponTelemetry(event),

	// Setting this option to true will print useful information to the console while you're setting up Sentry.
	debug: false,

	// Uncomment the line below to enable Spotlight (https://spotlightjs.com)
	// spotlight: process.env.NODE_ENV === 'development',
})
