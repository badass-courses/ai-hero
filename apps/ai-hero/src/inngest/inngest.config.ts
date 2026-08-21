import { aiCodingDictionaryIndex } from '@/inngest/functions/ai-coding-dictionary-index'
import { archivePurchaseReconciliation } from '@/inngest/functions/archive-purchase-reconciliation'
import { generateArtwork } from '@/inngest/functions/artwork/generate-artwork'
import { notifyOnPostCreated } from '@/inngest/functions/artwork/notify-on-post-created'
import { pickVariant } from '@/inngest/functions/artwork/pick-variant'
import { retryHandler } from '@/inngest/functions/artwork/retry-handler'
import { skipNotification } from '@/inngest/functions/artwork/skip-notification'
import { imageResourceCreated } from '@/inngest/functions/cloudinary/image-resource-created'
import { addPurchasesConvertkit } from '@/inngest/functions/convertkit/add-purchased-convertkit'
import { addSubscriptionRoleDiscord } from '@/inngest/functions/discord/add-subscription-discord-role'
import { discordAccountLinked } from '@/inngest/functions/discord/discord-account-linked'
import { removePurchaseRoleDiscord } from '@/inngest/functions/discord/remove-purchase-role-discord'
import { emailSendBroadcast } from '@/inngest/functions/email-send-broadcast'
import { ensurePersonalOrganizationWorkflow } from '@/inngest/functions/ensure-personal-organization'
import { userSignupAdminEmail } from '@/inngest/functions/notify/creator/user-signup'
import { performCodeExtraction } from '@/inngest/functions/ocr/ocr-code-extractor'
import { postmarkWebhook } from '@/inngest/functions/postmark/postmarks-webhooks-handler'
import { refundEntitlements } from '@/inngest/functions/refund/refund-entitlements'
import { sendWorkshopAccessEmails } from '@/inngest/functions/send-workshop-access-emails'
import { syncPurchaseTags } from '@/inngest/functions/sync-purchase-tags'
import { teamPurchaseFulfillmentWorkflow } from '@/inngest/functions/team-purchase-fulfillment-workflow'
import { userCreated } from '@/inngest/functions/user-created'
import { inngest } from '@/inngest/inngest.server'

import { courseBuilderCoreFunctions } from '@coursebuilder/core/inngest'

import {
	calendarSync,
	handleRefundAndRemoveFromCalendar,
} from './functions/calendar-sync'
import { cohortEntitlementSyncUser } from './functions/cohort-entitlement-sync-user'
import { cohortEntitlementSyncWorkflow } from './functions/cohort-entitlement-sync-workflow'
import { cohortReminderBroadcast } from './functions/cohort-reminder-broadcast'
import { getOrCreateConcept } from './functions/concepts/get-or-create-tag'
import { contentReadRetention } from './functions/content-read-retention'
import { contentResourceIndexRequested } from './functions/content-resource-index'
import { courseSyncDetectionPoller } from './functions/course-sync-detection-poller'
import { createPPPCreditCouponsForPurchasers } from './functions/coupon/create-ppp-credit-coupons-for-purchasers'
import { grantCouponEntitlements } from './functions/coupon/grant-coupon-entitlements'
import { grantCouponEntitlementsForPurchase } from './functions/coupon/grant-coupon-entitlements-for-purchase'
import { createUserOrganizations } from './functions/create-user-organization'
import { syncGithubSourcedPosts } from './functions/sync-github-sourced-posts'
import { googleAdsConversionUpload } from './functions/google-ads-conversion-upload'
import { invoiceShortfallReconciliation } from './functions/invoice-shortfall-reconciliation'
import { addDiscordRoleWorkflow } from './functions/discord/add-discord-role-workflow'
import { grantLegendDiscordRole } from './functions/discord/grant-legend-discord-role'
import { eventReminderBroadcast } from './functions/event-reminder-broadcast'
import { postEventPurchase } from './functions/post-event-purchase'
import { postPurchaseDiscordRole } from './functions/post-purchase-discord-role'
import { postPurchaseWelcomeEmail } from './functions/post-purchase-welcome-email'
import { postPurchaseWorkflow } from './functions/post-purchase-workflow'
import {
	apiProductTransferWorkflow,
	productTransferWorkflow,
} from './functions/product-transfer-workflow'
import {
	buyerPurchaseBenefitFollowup,
	teamSeatRedemptionBenefitFollowup,
} from './functions/purchase-benefit-followup'
import { sendLiveEventWelcomeEmail } from './functions/send-live-event-welcome-email'
import { shortlinkAttribution } from './functions/shortlink-attribution'
import { signupAttribution } from './functions/signup-attribution'
import { skillChangelogBroadcast } from './functions/skill-changelog-broadcast'
import { skillsNewsletterConfirmationReconciler } from './functions/skills-newsletter-confirmation-reconciler'
import { skillsNewsletterPathEntry } from './functions/skills-newsletter-path-entry'
import { workshopInterestSync } from './functions/workshop-interest-sync'
import { computeVideoSplitPoints } from './functions/split_video'
import { persistPurchaseGeo } from './functions/persist-purchase-geo'
import { stripeSubscriptionCheckoutSessionComplete } from './functions/stripe/event-subscription-checkout-session-completed'
import { typesensePopularitySync } from './functions/typesense-popularity-sync'
import { learnerFlowReconciler } from './functions/learner-flow-reconciler'
import { valuePathEmailExecutor } from './functions/value-path-email-executor'
import {
	videoResourceAttached,
	videoResourceDetached,
} from './functions/video-resource-attached'

// Vercel Preview/Development deployments auto-register into Inngest's shared
// branch environment, which runs every cron in this list against the
// production database (they share DATABASE_URL) without production-only
// secrets. Registering an empty manifest from those deployments archives the
// branch environment's functions instead. VERCEL_ENV is unset in local dev,
// so the Inngest dev server still sees the full list.
const isVercelNonProduction =
	process.env.VERCEL_ENV !== undefined && process.env.VERCEL_ENV !== 'production'

const allFunctions = [
	...courseBuilderCoreFunctions.map(({ config, trigger, handler }) =>
		inngest.createFunction(config, trigger, handler),
	),
	userCreated,
	userSignupAdminEmail,
	aiCodingDictionaryIndex,
	postmarkWebhook,
	archivePurchaseReconciliation,
	imageResourceCreated,
	emailSendBroadcast,
	performCodeExtraction,
	getOrCreateConcept,
	computeVideoSplitPoints,
	discordAccountLinked,
	addSubscriptionRoleDiscord,
	removePurchaseRoleDiscord,
	postPurchaseWorkflow,
	teamPurchaseFulfillmentWorkflow,
	postPurchaseDiscordRole,
	postPurchaseWelcomeEmail,
	buyerPurchaseBenefitFollowup,
	teamSeatRedemptionBenefitFollowup,
	productTransferWorkflow,
	apiProductTransferWorkflow,
	cohortEntitlementSyncWorkflow,
	cohortEntitlementSyncUser,
	syncPurchaseTags,
	addPurchasesConvertkit,
	stripeSubscriptionCheckoutSessionComplete,
	persistPurchaseGeo,
	createUserOrganizations,
	ensurePersonalOrganizationWorkflow,
	videoResourceAttached,
	videoResourceDetached,
	addDiscordRoleWorkflow,
	grantLegendDiscordRole,
	sendWorkshopAccessEmails,
	refundEntitlements,
	grantCouponEntitlements,
	grantCouponEntitlementsForPurchase,
	createPPPCreditCouponsForPurchasers,
	calendarSync,
	postEventPurchase,
	handleRefundAndRemoveFromCalendar,
	sendLiveEventWelcomeEmail,
	shortlinkAttribution,
	signupAttribution,
	eventReminderBroadcast,
	cohortReminderBroadcast,
	contentReadRetention,
	contentResourceIndexRequested,
	courseSyncDetectionPoller,
	typesensePopularitySync,
	valuePathEmailExecutor,
	learnerFlowReconciler,
	googleAdsConversionUpload,
	invoiceShortfallReconciliation,
	syncGithubSourcedPosts,
	skillChangelogBroadcast,
	skillsNewsletterPathEntry,
	workshopInterestSync,
	skillsNewsletterConfirmationReconciler,
	notifyOnPostCreated,
	generateArtwork,
	pickVariant,
	skipNotification,
	retryHandler,
]

export const inngestConfig = {
	client: inngest,
	functions: isVercelNonProduction ? [] : allFunctions,
}
