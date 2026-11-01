import { createHash } from 'node:crypto'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Preferences and unsubscribe links with Kit unreachable and
 * AIH_EMAIL_PREFERENCES_LOCAL_ENABLED on. Every Kit host refuses and the Kit
 * provider throws on any use. A signed link is checked against the contact
 * directory, state comes from local rows, ContactEvents and drovr stops, and
 * an unsubscribe lands whatever the directory says, short of a tampered link.
 */

const dialect = new MySqlDialect()

const mocks = vi.hoisted(() => ({
	identities: new Map<string, string>(),
	contacts: new Map<string, { email: string | null; name: string | null }>(),
	directoryDown: false,
	kitCalls: [] as string[],
	drovrStops: [] as { scope: 'all'; reason: string }[],
	drovrDown: false,
	usersByEmail: new Map<string, string>(),
	rows: [] as {
		id: string
		userId: string
		preferenceTypeId: string
		active: boolean
		updatedAt: Date
		optInAt: Date | null
		optOutAt: Date | null
	}[],
	contactEvents: [] as {
		eventType: string
		providerReference: string
		occurredAt: string
	}[],
	sent: [] as { name: string; data: Record<string, unknown> }[],
	sendFails: false,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

/** The bound values of a drizzle `where`, in order. */
function whereParams(args: unknown): unknown[] {
	const where = (args as { where?: unknown })?.where
	if (typeof where === 'function') {
		const captured: unknown[] = []
		const ops = {
			eq: (_column: unknown, value: unknown) => {
				captured.push(value)
				return true
			},
			and: () => true,
		}
		where({}, ops)
		return captured
	}
	return dialect.sqlToQuery(where as never).params
}

const TYPES = [
	{ id: 'type-newsletter', name: 'Newsletter' },
	{ id: 'type-skills', name: 'AI Skills Updates' },
]

vi.mock('@/db', () => ({
	db: {
		query: {
			providerIdentity: {
				findFirst: async (args: unknown) => {
					if (mocks.directoryDown) throw new Error('directory unavailable')
					const [provider, externalId] = whereParams(args)
					if (provider !== 'kit') return undefined
					const contactId = mocks.identities.get(String(externalId))
					return contactId ? { contactId } : undefined
				},
			},
			contact: {
				findFirst: async (args: unknown) => {
					const [id] = whereParams(args)
					return mocks.contacts.get(String(id))
				},
			},
			users: {
				findFirst: async (args: unknown) => {
					const [email] = whereParams(args)
					const id = mocks.usersByEmail.get(String(email))
					return id ? { id, email } : undefined
				},
			},
			communicationPreferenceTypes: {
				findMany: async () => TYPES,
				findFirst: async (args: unknown) => {
					const [name] = whereParams(args)
					return TYPES.find((type) => type.name === name)
				},
			},
			communicationChannel: {
				findFirst: async () => ({ id: 'channel-email', name: 'Email' }),
			},
			communicationPreferences: {
				findMany: async (args: unknown) => {
					const [userId] = whereParams(args)
					return mocks.rows.filter((row) => row.userId === userId)
				},
				findFirst: async (args: unknown) => {
					const [userId, preferenceTypeId] = whereParams(args)
					return mocks.rows.find(
						(row) =>
							row.userId === userId &&
							row.preferenceTypeId === preferenceTypeId,
					)
				},
			},
		},
		insert: () => ({
			values: async (value: (typeof mocks.rows)[number]) => {
				mocks.rows.push(value)
			},
		}),
		update: () => ({
			set: (patch: Partial<(typeof mocks.rows)[number]>) => ({
				where: async (where: unknown) => {
					const [id] = dialect.sqlToQuery(where as never).params
					const row = mocks.rows.find((candidate) => candidate.id === id)
					if (row) Object.assign(row, patch)
				},
			}),
		}),
	},
}))

vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {
		async findContactEventsByType(_contactId: string, eventType: string) {
			return mocks.contactEvents.filter(
				(event) => event.eventType === eventType,
			)
		}
	},
}))

vi.mock('@/coursebuilder/email-list-provider', () => {
	const unreachable = new Proxy(
		{},
		{
			get: (_target, property) => () => {
				mocks.kitCalls.push(String(property))
				throw new Error('Kit is unreachable')
			},
		},
	)
	return { emailListProvider: unreachable }
})

vi.mock('@/env.mjs', () => ({
	env: {
		AIH_EMAIL_PREFERENCES_LOCAL_ENABLED: 'true',
		DROVR_API_BASE_URL: 'https://drovr.test',
		DROVR_API_KEY_ORG_AIHERO: 'synthetic-org-key',
	},
}))

vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		send: async (event: { name: string; data: Record<string, unknown> }) => {
			if (mocks.sendFails) throw new Error('inngest unavailable')
			mocks.sent.push(event)
		},
	},
}))

vi.mock('react', async (original) => ({
	...(await original<typeof import('react')>()),
	cache: (fn: unknown) => fn,
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/navigation', () => ({
	redirect: (to: string) => {
		throw new Error(`redirect:${to}`)
	},
}))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: unknown }) => children,
}))
vi.mock('@/server/logger', () => ({
	log: mocks.log,
	serializeError: (error: unknown) => String(error),
}))
vi.mock('@/server/perf', () => ({
	measureIfSlow: ({ operation }: { operation: () => Promise<unknown> }) =>
		operation(),
}))

import { updateEmailPreferenceAction } from './preferences/actions'
import PreferencesPage from './preferences/page'
import { unsubscribeAction } from './unsubscribed/actions'
import Unsubscribed from './unsubscribed/page'
import { UnsubscribeForm } from './unsubscribed/unsubscribe-form'

const KIT_ID = '1234567'
const EMAIL = 'reader@example.test'
const SH_KIT = createHash('sha256').update(EMAIL).digest('hex')
const TAMPERED = createHash('sha256').update('someone@else.test').digest('hex')

const form = (fields: Record<string, string>) => {
	const data = new FormData()
	for (const [name, value] of Object.entries(fields)) data.set(name, value)
	return data
}

const unsubscribe = (fields: Record<string, string>) =>
	unsubscribeAction({ status: 'idle' }, form(fields))

/** Every string rendered anywhere in a server component tree. */
function textOf(node: unknown): string {
	if (node === null || node === undefined || typeof node === 'boolean')
		return ''
	if (typeof node === 'string' || typeof node === 'number') return String(node)
	if (Array.isArray(node)) return node.map(textOf).join(' ')
	const element = node as {
		type?: unknown
		props?: Record<string, unknown>
	}
	// The page's own SignIn* components; Next's Link and the layout stay opaque.
	if (
		typeof element.type === 'function' &&
		element.type.name.startsWith('SignIn')
	)
		return textOf((element.type as (p: unknown) => unknown)(element.props))
	const props = element.props ?? {}
	const value =
		typeof props.value === 'string' && props.name
			? ` [${props.name}=${props.value}]`
			: ''
	return `${textOf(props.children)}${value}`
}

const findForm = (node: any): any => {
	if (!node || typeof node !== 'object') return undefined
	if (node.type === UnsubscribeForm) return node
	const children = node.props?.children
	for (const child of Array.isArray(children) ? children : [children]) {
		const found = findForm(child)
		if (found) return found
	}
	return undefined
}

beforeEach(() => {
	mocks.identities.clear()
	mocks.contacts.clear()
	mocks.usersByEmail.clear()
	mocks.rows.length = 0
	mocks.contactEvents.length = 0
	mocks.sent.length = 0
	mocks.kitCalls.length = 0
	mocks.drovrStops = []
	mocks.drovrDown = false
	mocks.directoryDown = false
	mocks.sendFails = false
	mocks.identities.set(KIT_ID, 'contact-1')
	mocks.contacts.set('contact-1', { email: EMAIL, name: 'Reader' })
	mocks.usersByEmail.set(EMAIL, 'user-1')
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: unknown) => {
			const url = new URL(String(input))
			if (url.origin === 'https://drovr.test') {
				if (mocks.drovrDown) return new Response('down', { status: 503 })
				return Response.json({
					kitSubscriberId: url.searchParams.get('kitSubscriberId'),
					contactId: 'contact-1',
					stops: mocks.drovrStops,
				})
			}
			mocks.kitCalls.push(String(input))
			throw new TypeError('fetch failed: Kit is unreachable')
		}),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
	expect(mocks.kitCalls).toEqual([])
})

describe('/unsubscribed with Kit unreachable', () => {
	it('a valid link unsubscribes locally now and queues the rest', async () => {
		const page = await Unsubscribed({
			searchParams: Promise.resolve({
				ck_subscriber_id: KIT_ID,
				sh_kit: SH_KIT,
				preference: 'newsletter',
			}),
		})
		expect(findForm(page)?.props.hiddenFields).toMatchObject({
			ck_subscriber_id: KIT_ID,
			sh_kit: SH_KIT,
		})
		expect(mocks.sent).toEqual([])

		await expect(
			unsubscribe({
				ck_subscriber_id: KIT_ID,
				sh_kit: SH_KIT,
				preference: 'newsletter',
			}),
		).resolves.toEqual({ status: 'done' })

		expect(mocks.rows).toMatchObject([
			{ userId: 'user-1', preferenceTypeId: 'type-newsletter', active: false },
		])
		expect(mocks.sent).toMatchObject([
			{
				name: 'email-preferences/change-requested',
				data: {
					kitSubscriberId: KIT_ID,
					preferenceKey: 'newsletter',
					subscribed: false,
					email: EMAIL,
					localSynced: true,
				},
			},
		])
	})

	it('a tampered link changes nothing', async () => {
		await expect(
			Unsubscribed({
				searchParams: Promise.resolve({
					ck_subscriber_id: KIT_ID,
					sh_kit: TAMPERED,
				}),
			}),
		).rejects.toThrow('redirect:/')
		await expect(
			unsubscribe({ ck_subscriber_id: KIT_ID, sh_kit: TAMPERED }),
		).rejects.toThrow('redirect:/')
		expect(mocks.rows).toEqual([])
		expect(mocks.sent).toEqual([])
	})

	it('an unknown Kit id still lands: queued for verification, no local write', async () => {
		const page = await Unsubscribed({
			searchParams: Promise.resolve({
				ck_subscriber_id: '999',
				sh_kit: SH_KIT,
			}),
		})
		expect(findForm(page)).toBeDefined()

		await expect(
			unsubscribe({ ck_subscriber_id: '999', sh_kit: SH_KIT }),
		).resolves.toEqual({ status: 'done' })
		expect(mocks.rows).toEqual([])
		expect(mocks.sent).toHaveLength(1)
		expect(mocks.sent[0]?.data).toMatchObject({
			kitSubscriberId: '999',
			shKit: SH_KIT,
			subscribed: false,
		})
		expect(mocks.sent[0]?.data).not.toHaveProperty('email')
	})

	it('a failed directory read still lands: queued for verification', async () => {
		mocks.directoryDown = true
		const page = await Unsubscribed({
			searchParams: Promise.resolve({
				ck_subscriber_id: KIT_ID,
				sh_kit: SH_KIT,
			}),
		})
		expect(findForm(page)).toBeDefined()

		await expect(
			unsubscribe({ ck_subscriber_id: KIT_ID, sh_kit: SH_KIT }),
		).resolves.toEqual({ status: 'done' })
		expect(mocks.sent).toHaveLength(1)
		expect(mocks.sent[0]?.data).not.toHaveProperty('email')
	})

	it('says so when the change cannot be queued, never a false done', async () => {
		mocks.sendFails = true
		await expect(
			unsubscribe({ ck_subscriber_id: KIT_ID, sh_kit: SH_KIT }),
		).rejects.toThrow('inngest unavailable')
	})
})

describe('/preferences with Kit unreachable', () => {
	const view = (params: Record<string, string> = {}) =>
		PreferencesPage({
			searchParams: Promise.resolve({
				ck_subscriber_id: KIT_ID,
				sh_kit: SH_KIT,
				...params,
			}),
		}).then(textOf)

	it('a valid link reads local rows, ContactEvents and drovr stops', async () => {
		mocks.contactEvents.push({
			eventType: 'contact.unsubscribed',
			providerReference: 'kit:email-preference:ai-skills',
			occurredAt: '2026-10-01T00:00:00.000Z',
		})
		const text = await view()
		expect(text).toContain("You're getting these.")
		expect(text).toContain("You're not getting these.")
		expect(text).toContain('[subscribed=false]')
		// A stopped preference offers sign-in, never an opt-in form.
		expect(text).toContain('Sign in to resubscribe')
		expect(text).not.toContain('[subscribed=true]')
	})

	it('a drovr all-scope stop reads as unsubscribed from everything, with no opt-in', async () => {
		mocks.drovrStops = [{ scope: 'all', reason: 'unsubscribed' }]
		const text = await view()
		expect(text).toContain("You've unsubscribed from all AI Hero email.")
		expect(text).not.toContain("You're getting these.")
		expect(text).not.toContain('[subscribed=true]')
	})

	it('a failed drovr read never shows subscribed and only offers a stop', async () => {
		mocks.drovrDown = true
		const text = await view()
		expect(text).toContain("We couldn't load this setting right now.")
		expect(text).not.toContain("You're getting these.")
		expect(text).not.toContain('[subscribed=true]')
	})

	it('a failed directory read never shows subscribed and only offers a stop', async () => {
		mocks.directoryDown = true
		const text = await view()
		expect(text).toContain("We couldn't load this setting right now.")
		expect(text).not.toContain("You're getting these.")
		expect(text).not.toContain('[subscribed=true]')
	})

	it('an unknown id is never shown as subscribed', async () => {
		const text = await view({ ck_subscriber_id: '999' })
		expect(text).not.toContain("You're getting these.")
		expect(text).not.toContain('[subscribed=true]')
	})

	it('a tampered link asks for the email link', async () => {
		const text = await view({ sh_kit: TAMPERED })
		expect(text).toContain('We need the link from your email')
	})

	it('an opt-in from an unverifiable link lifts nothing', async () => {
		mocks.directoryDown = true
		await expect(
			updateEmailPreferenceAction(
				form({
					ck_subscriber_id: KIT_ID,
					sh_kit: SH_KIT,
					preference: 'newsletter',
					subscribed: 'true',
				}),
			),
		).rejects.toThrow('redirect:/preferences?error=sign-in-to-resubscribe')
		expect(mocks.sent).toEqual([])
		expect(mocks.rows).toEqual([])
	})

	it('an opt-out from an unverifiable link still lands', async () => {
		mocks.directoryDown = true
		await expect(
			updateEmailPreferenceAction(
				form({
					ck_subscriber_id: KIT_ID,
					sh_kit: SH_KIT,
					preference: 'ai-skills',
					subscribed: 'false',
				}),
			),
		).rejects.toThrow('state=unsubscribed')
		expect(mocks.sent).toHaveLength(1)
		expect(mocks.sent[0]?.data).toMatchObject({
			preferenceKey: 'ai-skills',
			subscribed: false,
		})
	})

	it('a verified link opt-in is refused: nothing queued, no row, no Kit write', async () => {
		await expect(
			updateEmailPreferenceAction(
				form({
					ck_subscriber_id: KIT_ID,
					sh_kit: SH_KIT,
					preference: 'ai-skills',
					subscribed: 'true',
				}),
			),
		).rejects.toThrow('redirect:/preferences?error=sign-in-to-resubscribe')
		expect(mocks.sent).toEqual([])
		expect(mocks.rows).toEqual([])
		expect(mocks.kitCalls).toEqual([])
		expect(mocks.log.info).toHaveBeenCalledWith(
			'email-preferences.change.accepted',
			expect.objectContaining({
				status: 'rejected',
				reason: 'link-opt-in-refused',
			}),
		)
	})

	it('shows the sign-in prompt for a refused opt-in', async () => {
		const text = await view({ error: 'sign-in-to-resubscribe' })
		expect(text).toContain('Sign in to resubscribe')
		expect(text).toContain("You're getting these.")
	})
})
