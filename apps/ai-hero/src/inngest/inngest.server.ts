import { emailProvider } from '@/coursebuilder/email-provider'
import { slackProvider } from '@/coursebuilder/slack-provider'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import {
	AI_CODING_DICTIONARY_SOURCE_CHANGED_EVENT,
	AiCodingDictionarySourceChanged,
} from '@/inngest/events/ai-coding-dictionary'
import {
	GITHUB_SOURCE_SYNC_REQUESTED_EVENT,
	GithubSourceSyncRequested,
} from '@/inngest/events/github-source'
import {
	EMAIL_SEND_BROADCAST,
	EmailSendBroadcast,
} from '@/inngest/events/email-send-broadcast'
import {
	ENSURE_PERSONAL_ORGANIZATION_EVENT,
	EnsurePersonalOrganization,
} from '@/inngest/events/ensure-personal-organization'
import {
	GRANT_COUPON_ENTITLEMENTS_FOR_PURCHASE_EVENT,
	GrantCouponEntitlementsForPurchase,
} from '@/inngest/events/grant-coupon-entitlements-for-purchase'
import {
	GRANT_LEGEND_DISCORD_ROLE_EVENT,
	GrantLegendDiscordRole,
} from '@/inngest/events/grant-legend-discord-role'
import {
	POST_PURCHASE_DISCORD_ROLE_REQUESTED_EVENT,
	POST_PURCHASE_WELCOME_EMAIL_REQUESTED_EVENT,
	PostPurchaseDiscordRoleRequested,
	PostPurchaseWelcomeEmailRequested,
} from '@/inngest/events/post-purchase-async'
import {
	IMAGE_RESOURCE_CREATED_EVENT,
	ImageResourceCreated,
} from '@/inngest/events/image-resource-created'
import {
	INVOICE_SHORTFALL_RECONCILE_EVENT,
	InvoiceShortfallReconcile,
} from '@/inngest/events/invoice-shortfall'
import {
	LESSON_COMPLETED_EVENT,
	LessonCompleted,
} from '@/inngest/events/lesson-completed'
import {
	NO_PROGRESS_MADE_EVENT,
	NoProgressMade,
} from '@/inngest/events/no-progress-made-event'
import {
	OAUTH_PROVIDER_ACCOUNT_LINKED_EVENT,
	OauthProviderAccountLinked,
} from '@/inngest/events/oauth-provider-account-linked'
import {
	POSTMARK_WEBHOOK_EVENT,
	PostmarkWebhook,
} from '@/inngest/events/postmark-webhook'
import {
	SKILL_CHANGELOG_PUBLISHED_EVENT,
	SkillChangelogPublished,
} from '@/inngest/events/skill-changelog'
import {
	TYPESENSE_POPULARITY_SYNC_REQUESTED_EVENT,
	TypesensePopularitySyncRequested,
} from '@/inngest/events/typesense-popularity'
import { USER_CREATED_EVENT, UserCreated } from '@/inngest/events/user-created'
import {
	VALUE_PATH_ANSWER_SELECTED_EVENT,
	type ValuePathAnswerSelected,
} from '@/inngest/events/value-path'
import {
	VIDEO_ATTACHED_EVENT,
	VIDEO_DETACHED_EVENT,
	VideoAttached,
	VideoDetached,
} from '@/inngest/events/video-attachment'
import {
	CREATE_PPP_CREDIT_COUPONS_FOR_PURCHASERS_EVENT,
	CreatePPPCreditCouponsForPurchasersEvent,
} from '@/inngest/functions/coupon/create-ppp-credit-coupons-for-purchasers'
import {
	GRANT_COUPON_ENTITLEMENTS_EVENT,
	GrantCouponEntitlementsEvent,
} from '@/inngest/functions/coupon/grant-coupon-entitlements'
import {
	SYNC_PURCHASE_TAGS_EVENT,
	SyncPurchaseTags,
} from '@/inngest/functions/sync-purchase-tags'
import { authOptions } from '@/server/auth'
import { EventSchemas, Inngest } from 'inngest'
import { UTApi } from 'uploadthing/server'

import { CourseBuilderCoreEvents } from '@coursebuilder/core/inngest'
import {
	RESOURCE_CHAT_REQUEST_EVENT,
	ResourceChat,
} from '@coursebuilder/core/inngest/co-gardener/resource-chat'
import {
	NEW_SUBSCRIPTION_CREATED_EVENT,
	NewSubscriptionCreated,
} from '@coursebuilder/core/inngest/commerce/event-new-subscription-created'
import { createInngestMiddleware } from '@coursebuilder/core/inngest/create-inngest-middleware'
import type {
	PURCHASE_TRANSFERRED_API_EVENT,
	PURCHASE_TRANSFERRED_EVENT,
	PurchaseTransferred,
	PurchaseTransferredApi,
} from '@coursebuilder/core/inngest/purchase-transfer/event-purchase-transferred'
import {
	STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT,
	StripeCheckoutSessionCompleted,
} from '@coursebuilder/core/inngest/stripe/event-checkout-session-completed'
import DeepgramProvider from '@coursebuilder/core/providers/deepgram'
import OpenAIProvider from '@coursebuilder/core/providers/openai'
import PartykitProvider from '@coursebuilder/core/providers/partykit'

import {
	ARTWORK_FAL_COMPLETED_EVENT,
	ARTWORK_GENERATION_FAILED_EVENT,
	ArtworkFalCompleted,
	ArtworkGenerationFailed,
	SLACK_ARTWORK_GENERATE_REQUESTED_EVENT,
	SLACK_ARTWORK_PICK_REQUESTED_EVENT,
	SLACK_ARTWORK_REGENERATE_REQUESTED_EVENT,
	SLACK_ARTWORK_RETRY_REQUESTED_EVENT,
	SLACK_ARTWORK_SKIP_REQUESTED_EVENT,
	SlackArtworkGenerateRequested,
	SlackArtworkPickRequested,
	SlackArtworkRegenerateRequested,
	SlackArtworkRetryRequested,
	SlackArtworkSkipRequested,
} from './events/artwork'
import {
	COHORT_ENTITLEMENT_SYNC_USER_EVENT,
	COHORT_UPDATED_EVENT,
	CohortEntitlementSyncUserPayload,
	CohortUpdatedPayload,
} from './events/cohort-management'
import {
	CONCEPT_SELECTED,
	CONCEPT_TAGS_REQUESTED,
	REQUEST_CONCEPT_SELECTION,
	type ConceptSelected,
	type ConceptTagsRequested,
	type RequestConceptSelection,
} from './events/concepts'
import { OCR_WEBHOOK_EVENT, OcrWebhook } from './events/ocr-webhook'
import {
	RESOURCE_CREATED_EVENT,
	RESOURCE_UPDATED_EVENT,
	ResourceCreated,
	ResourceUpdated,
} from './events/resource-management'
import {
	REQUEST_VIDEO_SPLIT_POINTS,
	type RequestVideoSplitPoints,
} from './events/split_video'
import {
	CREATE_USER_ORGANIZATIONS_EVENT,
	CreateUserOrganizations,
} from './functions/create-user-organization'
import {
	USER_ADDED_TO_COHORT_EVENT,
	USER_ADDED_TO_WORKSHOP_EVENT,
	UserAddedToCohort,
	UserAddedToWorkshop,
} from './functions/discord/add-discord-role-workflow'
import { inngestTelemetryMiddleware } from './inngest-telemetry-middleware'

// Create a client to send and receive events
export type Events = {
	[USER_CREATED_EVENT]: UserCreated
	[AI_CODING_DICTIONARY_SOURCE_CHANGED_EVENT]: AiCodingDictionarySourceChanged
	[GITHUB_SOURCE_SYNC_REQUESTED_EVENT]: GithubSourceSyncRequested
	[POSTMARK_WEBHOOK_EVENT]: PostmarkWebhook
	[IMAGE_RESOURCE_CREATED_EVENT]: ImageResourceCreated
	[INVOICE_SHORTFALL_RECONCILE_EVENT]: InvoiceShortfallReconcile
	[RESOURCE_CHAT_REQUEST_EVENT]: ResourceChat
	[EMAIL_SEND_BROADCAST]: EmailSendBroadcast
	[OCR_WEBHOOK_EVENT]: OcrWebhook
	[CONCEPT_TAGS_REQUESTED]: ConceptTagsRequested
	[REQUEST_CONCEPT_SELECTION]: RequestConceptSelection
	[CONCEPT_SELECTED]: ConceptSelected
	[REQUEST_VIDEO_SPLIT_POINTS]: RequestVideoSplitPoints
	[LESSON_COMPLETED_EVENT]: LessonCompleted
	[OAUTH_PROVIDER_ACCOUNT_LINKED_EVENT]: OauthProviderAccountLinked
	[NO_PROGRESS_MADE_EVENT]: NoProgressMade
	[SYNC_PURCHASE_TAGS_EVENT]: SyncPurchaseTags
	[STRIPE_CHECKOUT_SESSION_COMPLETED_EVENT]: StripeCheckoutSessionCompleted
	[CREATE_USER_ORGANIZATIONS_EVENT]: CreateUserOrganizations
	[NEW_SUBSCRIPTION_CREATED_EVENT]: NewSubscriptionCreated
	[VIDEO_ATTACHED_EVENT]: VideoAttached
	[VIDEO_DETACHED_EVENT]: VideoDetached
	[PURCHASE_TRANSFERRED_EVENT]: PurchaseTransferred
	[PURCHASE_TRANSFERRED_API_EVENT]: PurchaseTransferredApi
	[ENSURE_PERSONAL_ORGANIZATION_EVENT]: EnsurePersonalOrganization
	[USER_ADDED_TO_COHORT_EVENT]: UserAddedToCohort
	[USER_ADDED_TO_WORKSHOP_EVENT]: UserAddedToWorkshop
	[COHORT_UPDATED_EVENT]: { data: CohortUpdatedPayload }
	[COHORT_ENTITLEMENT_SYNC_USER_EVENT]: {
		data: CohortEntitlementSyncUserPayload
	}
	[GRANT_COUPON_ENTITLEMENTS_EVENT]: GrantCouponEntitlementsEvent
	[GRANT_COUPON_ENTITLEMENTS_FOR_PURCHASE_EVENT]: GrantCouponEntitlementsForPurchase
	[GRANT_LEGEND_DISCORD_ROLE_EVENT]: GrantLegendDiscordRole
	[POST_PURCHASE_DISCORD_ROLE_REQUESTED_EVENT]: PostPurchaseDiscordRoleRequested
	[POST_PURCHASE_WELCOME_EMAIL_REQUESTED_EVENT]: PostPurchaseWelcomeEmailRequested
	[CREATE_PPP_CREDIT_COUPONS_FOR_PURCHASERS_EVENT]: CreatePPPCreditCouponsForPurchasersEvent
	[RESOURCE_CREATED_EVENT]: ResourceCreated
	[RESOURCE_UPDATED_EVENT]: ResourceUpdated
	[SKILL_CHANGELOG_PUBLISHED_EVENT]: SkillChangelogPublished
	[TYPESENSE_POPULARITY_SYNC_REQUESTED_EVENT]: TypesensePopularitySyncRequested
	[SLACK_ARTWORK_GENERATE_REQUESTED_EVENT]: SlackArtworkGenerateRequested
	[SLACK_ARTWORK_REGENERATE_REQUESTED_EVENT]: SlackArtworkRegenerateRequested
	[SLACK_ARTWORK_PICK_REQUESTED_EVENT]: SlackArtworkPickRequested
	[SLACK_ARTWORK_SKIP_REQUESTED_EVENT]: SlackArtworkSkipRequested
	[SLACK_ARTWORK_RETRY_REQUESTED_EVENT]: SlackArtworkRetryRequested
	[ARTWORK_FAL_COMPLETED_EVENT]: ArtworkFalCompleted
	[ARTWORK_GENERATION_FAILED_EVENT]: ArtworkGenerationFailed
	[VALUE_PATH_ANSWER_SELECTED_EVENT]: ValuePathAnswerSelected
}

const callbackBase =
	env.NODE_ENV === 'production' ? env.UPLOADTHING_URL : env.NEXT_PUBLIC_URL

const middleware = createInngestMiddleware({
	db: courseBuilderAdapter,
	siteRootUrl: env.NEXT_PUBLIC_URL,
	mediaUploadProvider: new UTApi(),
	openaiProvider: OpenAIProvider({
		apiKey: env.OPENAI_API_KEY,
		partyUrlBase: env.NEXT_PUBLIC_PARTY_KIT_URL,
	}),
	partyProvider: PartykitProvider({
		partyUrlBase: env.NEXT_PUBLIC_PARTY_KIT_URL,
	}),
	transcriptProvider: DeepgramProvider({
		apiKey: env.DEEPGRAM_API_KEY,
		callbackUrl: `${callbackBase}/api/coursebuilder/webhook/deepgram`,
	}),
	paymentProvider: stripeProvider,
	emailProvider,
	notificationProvider: slackProvider,
	getAuthConfig: () => authOptions,
})

export const inngest = new Inngest({
	id: env.NEXT_PUBLIC_APP_NAME,
	middleware: [middleware, inngestTelemetryMiddleware],
	schemas: new EventSchemas().fromRecord<Events & CourseBuilderCoreEvents>(),
})
