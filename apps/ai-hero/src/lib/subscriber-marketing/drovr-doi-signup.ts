import { z } from 'zod'

import {
	captureNormalizedContactEvent,
	type CaptureMarketingRepository,
} from './capture-contact-event'
import { emailEquivalenceKey } from './contact-email-equivalence'
import { DROVR_AUTHORITY_TENANT_ID } from './drovr-shadow-emitter'
import { normalizeContactEvent } from './normalize-contact-event'
import type { OptInAttribution } from './opt-in-attribution'

/**
 * drovr-owned double opt-in, ai-hero's signup side (#55 S8).
 *
 * With `DROVR_DOI_FORMS` on for a Kit form (for everyone, or for an
 * allowlist of addresses during the canary), a signup is not sent to Kit.
 * ai-hero finds or creates the contact and records the signup with drovr
 * (`POST /signups`), which sends the confirmation email and births the
 * course only once the reader confirms. No Kit subscribe, no
 * `skills-newsletter.subscribed`, no value-path birth here.
 *
 * Off, or without drovr's base URL and tenant key, every signup takes
 * today's Kit path unchanged: the flag is the kill switch, and a
 * half-configured deployment never strands a signup.
 */

/** Kit forms that can run drovr double opt-in, to drovr's registered form id. */
export const DOI_DROVR_FORM_IDS: ReadonlyMap<number, string> = new Map([
	[9376133, 'skills-newsletter'],
])

export type DrovrDoiConfig = {
	/** Per Kit form: everyone, or only these (lowercased) addresses. */
	forms: ReadonlyMap<number, 'everyone' | ReadonlySet<string>>
	baseUrl: string
	apiKey: string
}

/**
 * `DROVR_DOI_FORMS` is a comma list. `9376133` turns the form on for
 * everyone; `9376133:a@example.com|b@example.com` turns it on for those
 * addresses only (the canary). Unknown forms and junk are ignored. Answers
 * undefined (off) when nothing parses or drovr isn't configured.
 */
export function parseDrovrDoiConfig(env: {
	DROVR_DOI_FORMS?: string
	DROVR_API_BASE_URL?: string
	DROVR_SHADOW_INGEST_URL?: string
	DROVR_API_KEY_ORG_AIHERO?: string
}): DrovrDoiConfig | undefined {
	const forms = new Map<number, 'everyone' | ReadonlySet<string>>()
	for (const entry of (env.DROVR_DOI_FORMS ?? '').split(',')) {
		const [formPart, emailPart] = entry.trim().split(':', 2)
		const formId = Number(formPart)
		if (
			!formPart ||
			!Number.isInteger(formId) ||
			!DOI_DROVR_FORM_IDS.has(formId)
		)
			continue
		if (emailPart === undefined) {
			forms.set(formId, 'everyone')
			continue
		}
		const emails = new Set(
			emailPart
				.split('|')
				.map((email) => email.trim().toLowerCase())
				.filter((email) => email.includes('@')),
		)
		if (emails.size > 0 && forms.get(formId) !== 'everyone') {
			forms.set(formId, emails)
		}
	}
	const baseUrl = resolveBaseUrl(env)
	const apiKey = env.DROVR_API_KEY_ORG_AIHERO?.trim()
	if (forms.size === 0 || !baseUrl || !apiKey) return undefined
	return { forms, baseUrl, apiKey }
}

function resolveBaseUrl(env: {
	DROVR_API_BASE_URL?: string
	DROVR_SHADOW_INGEST_URL?: string
}) {
	const explicit = env.DROVR_API_BASE_URL?.trim()
	if (explicit) return explicit.replace(/\/+$/, '')
	const ingest = env.DROVR_SHADOW_INGEST_URL?.trim()
	if (!ingest) return undefined
	try {
		return new URL(ingest).origin
	} catch {
		return undefined
	}
}

/** Whether this signup takes drovr's double opt-in instead of Kit's form. */
export function doiAppliesTo(
	config: DrovrDoiConfig | undefined,
	kitFormId: number,
	email: string,
): boolean {
	const rule = config?.forms.get(kitFormId)
	if (!rule) return false
	return rule === 'everyone' || rule.has(email.trim().toLowerCase())
}

export class DoiSignupContactAmbiguousError extends Error {
	constructor() {
		super('More than one contact shares this address')
		this.name = 'DoiSignupContactAmbiguousError'
	}
}

/**
 * Find or create the signup's contact without Kit. The address's canonical
 * email key names an `ai-hero` identity (`doi-email:<key>`), so a repeat
 * signup resolves to the same contact. The first time, a contact that
 * already has this address (under a Kit identity) is reused, never
 * duplicated; two such contacts are ambiguous and refused. The capture
 * writes a `skills-newsletter.doi-requested` event and the contact state,
 * and drovr's shadow emitter maps that event to nothing: no value-path
 * birth before confirmation.
 */
export async function resolveDoiSignupContact(args: {
	repository: CaptureMarketingRepository
	findContactIdsByEmailKey: (emailKey: string) => Promise<string[]>
	email: string
	name?: string
	drovrFormId: string
	optInAttribution?: OptInAttribution
	now: string
}): Promise<{ contactId: string }> {
	const emailKey = emailEquivalenceKey(args.email)
	const externalId = `doi-email:${emailKey}`
	const linked = await args.repository.findProviderIdentity(
		'ai-hero',
		externalId,
	)
	if (!linked) {
		const existing = await args.findContactIdsByEmailKey(emailKey)
		if (existing.length > 1) throw new DoiSignupContactAmbiguousError()
		const contactId = existing[0]
		if (contactId) {
			try {
				await args.repository.createProviderIdentity({
					contactId,
					provider: 'ai-hero',
					externalId,
					evidence: {
						providerIdentity: { provider: 'ai-hero', externalId },
						source: 'ai-hero',
						strength: 'medium',
					},
					createdAt: args.now,
					updatedAt: args.now,
				})
			} catch (cause) {
				// A concurrent signup linked it first; that link stands.
				if (
					!(await args.repository.findProviderIdentity('ai-hero', externalId))
				)
					throw cause
			}
		}
	}
	const capture = await captureNormalizedContactEvent({
		repository: args.repository,
		event: normalizeContactEvent({
			provider: 'ai-hero',
			providerEventId: `doi-request:${args.drovrFormId}:${externalId}`,
			eventType: DOI_REQUESTED_EVENT_TYPE,
			occurredAt: args.now,
			email: args.email,
			name: args.name,
			externalId,
			message: `Double opt-in signup for ${args.drovrFormId}`,
			privacyLevel: 'internal',
			optInAttribution: args.optInAttribution
				? { ...args.optInAttribution, subscribedAt: args.now }
				: undefined,
		}),
		now: args.now,
	})
	return { contactId: capture.contact.id }
}

export const DOI_REQUESTED_EVENT_TYPE = 'skills-newsletter.doi-requested'

export type DrovrSignupRequest = {
	tenantId: typeof DROVR_AUTHORITY_TENANT_ID
	contactId: string
	formId: string
	occurredAt: string
	submissionId: string
	source: { page: string; referrer?: string; formVersion?: string }
}

export function buildDrovrSignupRequest(args: {
	contactId: string
	drovrFormId: string
	occurredAt: string
	submissionId: string
	page: string
	referrer?: string
}): DrovrSignupRequest {
	return {
		tenantId: DROVR_AUTHORITY_TENANT_ID,
		contactId: args.contactId,
		formId: args.drovrFormId,
		occurredAt: args.occurredAt,
		submissionId: args.submissionId,
		source: {
			page: args.page,
			...(args.referrer ? { referrer: args.referrer } : {}),
		},
	}
}

const SignupReply = z.object({
	status: z.enum(['awaiting-confirmation', 'already-confirmed', 'suppressed']),
})
export type DrovrSignupStatus = z.infer<typeof SignupReply>['status']

/** drovr could not take the signup now; the caller's durable delivery retries. */
export class DrovrSignupRetryableError extends Error {
	readonly httpStatus?: number
	constructor(detail: string, httpStatus?: number) {
		super(`drovr signup not recorded yet: ${detail}`)
		this.name = 'DrovrSignupRetryableError'
		this.httpStatus = httpStatus
	}
}

/** drovr refused the signup for good (a 4xx); retrying cannot help. */
export class DrovrSignupRefusedError extends Error {
	readonly httpStatus: number
	constructor(httpStatus: number, slug?: string) {
		super(`drovr refused the signup: ${httpStatus}${slug ? ` ${slug}` : ''}`)
		this.name = 'DrovrSignupRefusedError'
		this.httpStatus = httpStatus
	}
}

type Fetcher = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>

/**
 * `POST {drovr}/signups`, parsed at the boundary. Idempotent per tenant,
 * contact and form; the same submissionId replayed is a no-op, a new one is
 * a resend request that drovr rate-limits. 408/429/5xx and network failures
 * throw DrovrSignupRetryableError; any other 4xx throws
 * DrovrSignupRefusedError.
 */
export async function postDrovrSignup(
	request: DrovrSignupRequest,
	config: {
		baseUrl: string
		apiKey: string
		fetch?: Fetcher
		timeoutMs?: number
	},
): Promise<DrovrSignupStatus> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000)
	let response: Response
	try {
		response = await (config.fetch ?? fetch)(`${config.baseUrl}/signups`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${config.apiKey}`,
				'content-type': 'application/json',
				accept: 'application/json',
			},
			body: JSON.stringify(request),
			signal: controller.signal,
		})
	} catch (error) {
		throw new DrovrSignupRetryableError(
			error instanceof Error ? error.name : 'unreachable',
		)
	} finally {
		clearTimeout(timer)
	}
	if (
		response.status === 408 ||
		response.status === 429 ||
		response.status >= 500
	) {
		throw new DrovrSignupRetryableError(
			`HTTP ${response.status}`,
			response.status,
		)
	}
	const body: unknown = await response.json().catch(() => undefined)
	if (response.status !== 200) {
		const slug = z.object({ type: z.string() }).safeParse(body)
		throw new DrovrSignupRefusedError(
			response.status,
			slug.success ? slug.data.type : undefined,
		)
	}
	const reply = SignupReply.safeParse(body)
	if (!reply.success) {
		throw new DrovrSignupRetryableError('unreadable reply', response.status)
	}
	return reply.data.status
}
