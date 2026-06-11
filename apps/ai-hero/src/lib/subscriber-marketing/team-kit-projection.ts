const VALID_PURCHASE_STATUSES = ['Valid', 'Restricted'] as const

export const TEAM_KIT_OWNER_TAG_NAME = 'AIH Team Owner'
export const TEAM_KIT_MEMBER_TAG_NAME = 'AIH Team Member'

export const TEAM_KIT_FIELD_KEYS = [
	'aih_team_role',
	'aih_team_ids',
	'aih_team_latest_team_id',
	'aih_team_seat_count',
	'aih_team_used_seat_count',
	'aih_team_latest_product',
	'aih_team_latest_purchase_at',
] as const

export type TeamKitFieldKey = (typeof TEAM_KIT_FIELD_KEYS)[number]

export type TeamKitRole = 'owner' | 'member' | 'owner_member' | 'none'

export type TeamKitProjectionFields = Record<TeamKitFieldKey, string>

export type TeamKitProjectionContact = {
	contactKey: string
	email: string
	name?: string | null
	userId?: string | null
	role: TeamKitRole
	teamIds: string[]
	ownerTeamIds: string[]
	memberTeamIds: string[]
	seatCount: number
	usedSeatCount: number
	latestTeamId: string
	latestProduct: string
	latestPurchaseAt: string
	fields: TeamKitProjectionFields
}

export type TeamKitProjectionPreview = {
	mode: 'team-kit-projection-preview'
	status: 'dry-run' | 'written'
	counts: {
		ownerPurchases: number
		memberPurchases: number
		contacts: number
		ownerContacts: number
		memberContacts: number
		ownerMemberContacts: number
		missingEmails: number
		kitSubscribersFound: number
		kitSubscribersMissing: number
		fieldWritesProposed: number
		fieldWritesPerformed: number
		tagWritesProposed: number
		tagWritesPerformed: number
	}
	contacts: TeamKitProjectionContact[]
	kit?: TeamKitProjectionKitReceipt[]
	skipped: TeamKitProjectionSkipped[]
	privacy: {
		rawEmailsIncluded: true
		rawPayloadIncluded: false
		customerVisibleSideEffects: false
	}
	rationale: string[]
}

export type TeamKitProjectionSkipped = {
	reason: string
	purchaseId?: string
	userId?: string | null
	teamId?: string | null
}

export type TeamKitProjectionKitReceipt = {
	email: string
	subscriberFound: boolean
	subscriberId?: string
	fieldWriteAttempted: boolean
	fieldWritePerformed: boolean
	tagWriteAttempted: boolean
	tagWritePerformed: boolean
	tags: string[]
	reasons: string[]
}

export type TeamKitProjectionProvider = {
	getSubscriberByEmail: (email: string) => Promise<{
		id: string | number
		fields?: Record<string, string | null | undefined>
	} | null>
	updateSubscriberFields?: (args: {
		subscriberId?: string
		subscriberEmail?: string
		fields: Record<string, string>
	}) => Promise<unknown>
	subscribeToList?: (args: {
		listId?: string | number
		listType: string
		user: any
		fields: Record<string, string>
	}) => Promise<unknown>
}

export type TeamPurchaseRow = {
	purchaseId: string
	userId: string | null
	email: string | null
	name: string | null
	teamId: string | null
	productId: string
	productName: string | null
	productSlug: string | null
	purchaseCreatedAt: Date | string
	couponMaxUses: number | null
	couponUsedCount: number | null
}

type TeamKitProjectionDatabase = any

/**
 * Previews (or writes, when allowWrite is true) the Kit tag and field projection
 * for all team owner and member purchases.
 *
 * @param args.database - Drizzle database connection; required unless purchase rows are passed directly
 * @param args.ownerPurchases - Pre-loaded owner rows (skips DB query when provided)
 * @param args.memberPurchases - Pre-loaded member rows (skips DB query when provided)
 * @param args.limit - Max contacts to process in this batch
 * @param args.offset - Zero-based offset for paginated runs
 * @param args.provider - Kit provider implementing field updates and list subscriptions
 * @param args.allowWrite - When true, writes are performed; defaults to dry-run preview
 * @param args.ownerTagId - Kit tag ID to apply to team owners
 * @param args.memberTagId - Kit tag ID to apply to team members
 * @param args.kitLookupDelayMs - Ms to wait between Kit subscriber lookups
 * @param args.kitLookupMaxAttempts - Max retries for Kit subscriber lookup
 * @returns Summary preview including receipts, skipped contacts, and proposed tag counts
 * @throws If database is required but not provided
 */
export async function previewTeamKitProjection(args: {
	database?: TeamKitProjectionDatabase
	ownerPurchases?: TeamPurchaseRow[]
	memberPurchases?: TeamPurchaseRow[]
	limit?: number
	offset?: number
	provider?: TeamKitProjectionProvider
	allowWrite?: boolean
	ownerTagId?: string | number
	memberTagId?: string | number
	kitLookupDelayMs?: number
	kitLookupMaxAttempts?: number
}): Promise<TeamKitProjectionPreview> {
	const ownerPurchases =
		args.ownerPurchases ??
		(await findTeamOwnerPurchases(requireDatabase(args.database)))
	const memberPurchases =
		args.memberPurchases ??
		(await findTeamMemberPurchases(requireDatabase(args.database)))
	const skipped: TeamKitProjectionSkipped[] = []
	const contacts = buildTeamKitProjectionContacts({
		ownerPurchases,
		memberPurchases,
		skipped,
	})
	const startIndex = Math.max(0, args.offset ?? 0)
	const limitedContacts = args.limit
		? contacts.slice(startIndex, startIndex + args.limit)
		: contacts.slice(startIndex)
	const kitReceipts = args.provider
		? await previewOrWriteKitProjection({
				contacts: limitedContacts,
				provider: args.provider,
				allowWrite: args.allowWrite ?? false,
				ownerTagId: args.ownerTagId,
				memberTagId: args.memberTagId,
				lookupDelayMs: args.kitLookupDelayMs,
				lookupMaxAttempts: args.kitLookupMaxAttempts,
			})
		: undefined
	const tagWritesProposed = limitedContacts.reduce(
		(count, contact) => count + tagsForRole(contact.role).length,
		0,
	)
	const kitSubscribersFound =
		kitReceipts?.filter((row) => row.subscriberFound).length ?? 0
	const kitSubscribersMissing =
		kitReceipts?.filter((row) => !row.subscriberFound).length ?? 0

	return {
		mode: 'team-kit-projection-preview',
		status: args.allowWrite ? 'written' : 'dry-run',
		counts: {
			ownerPurchases: ownerPurchases.length,
			memberPurchases: memberPurchases.length,
			contacts: limitedContacts.length,
			ownerContacts: limitedContacts.filter(
				(contact) => contact.role === 'owner',
			).length,
			memberContacts: limitedContacts.filter(
				(contact) => contact.role === 'member',
			).length,
			ownerMemberContacts: limitedContacts.filter(
				(contact) => contact.role === 'owner_member',
			).length,
			missingEmails: skipped.filter((row) => row.reason === 'missing-email')
				.length,
			kitSubscribersFound,
			kitSubscribersMissing,
			fieldWritesProposed: limitedContacts.length,
			fieldWritesPerformed:
				kitReceipts?.filter((row) => row.fieldWritePerformed).length ?? 0,
			tagWritesProposed,
			tagWritesPerformed:
				kitReceipts?.reduce(
					(count, row) => count + (row.tagWritePerformed ? row.tags.length : 0),
					0,
				) ?? 0,
		},
		contacts: limitedContacts,
		kit: kitReceipts,
		skipped,
		privacy: {
			rawEmailsIncluded: true,
			rawPayloadIncluded: false,
			customerVisibleSideEffects: false,
		},
		rationale: [
			'Course Builder purchase, bulk coupon, and redemption state is Durable Truth for AI Hero team relationships.',
			'Kit receives broad owner/member tags plus bounded aih_team_* fields only.',
			args.allowWrite
				? 'Operator requested write mode. Kit field and tag writes were attempted only for resolved Kit subscribers.'
				: 'Dry run only. No Kit field or tag write was attempted.',
		],
	}
}

async function findTeamOwnerPurchases(
	database: TeamKitProjectionDatabase,
): Promise<TeamPurchaseRow[]> {
	const { coupon, products, purchases, users } = await import('@/db/schema')
	const { and, desc, eq, inArray, isNotNull } = await import('drizzle-orm')
	const rows = await database
		.select({
			purchaseId: purchases.id,
			userId: purchases.userId,
			email: users.email,
			name: users.name,
			teamId: purchases.bulkCouponId,
			productId: purchases.productId,
			productName: products.name,
			productSlug: products.fields,
			purchaseCreatedAt: purchases.createdAt,
			couponMaxUses: coupon.maxUses,
			couponUsedCount: coupon.usedCount,
		})
		.from(purchases)
		.leftJoin(users, eq(purchases.userId, users.id))
		.leftJoin(products, eq(purchases.productId, products.id))
		.leftJoin(coupon, eq(purchases.bulkCouponId, coupon.id))
		.where(
			and(
				inArray(purchases.status, [...VALID_PURCHASE_STATUSES]),
				isNotNull(purchases.bulkCouponId),
			),
		)
		.orderBy(desc(purchases.createdAt))

	return rows.map(normalizeTeamPurchaseRow)
}

async function findTeamMemberPurchases(
	database: TeamKitProjectionDatabase,
): Promise<TeamPurchaseRow[]> {
	const { coupon, products, purchases, users } = await import('@/db/schema')
	const { and, desc, eq, inArray, isNotNull } = await import('drizzle-orm')
	const rows = await database
		.select({
			purchaseId: purchases.id,
			userId: purchases.userId,
			email: users.email,
			name: users.name,
			teamId: purchases.redeemedBulkCouponId,
			productId: purchases.productId,
			productName: products.name,
			productSlug: products.fields,
			purchaseCreatedAt: purchases.createdAt,
			couponMaxUses: coupon.maxUses,
			couponUsedCount: coupon.usedCount,
		})
		.from(purchases)
		.leftJoin(users, eq(purchases.userId, users.id))
		.leftJoin(products, eq(purchases.productId, products.id))
		.leftJoin(coupon, eq(purchases.redeemedBulkCouponId, coupon.id))
		.where(
			and(
				inArray(purchases.status, [...VALID_PURCHASE_STATUSES]),
				isNotNull(purchases.redeemedBulkCouponId),
			),
		)
		.orderBy(desc(purchases.createdAt))

	return rows.map(normalizeTeamPurchaseRow)
}

function normalizeTeamPurchaseRow(row: any): TeamPurchaseRow {
	return {
		purchaseId: String(row.purchaseId),
		userId: row.userId ?? null,
		email: row.email ?? null,
		name: row.name ?? null,
		teamId: row.teamId ?? null,
		productId: String(row.productId),
		productName: row.productName ?? null,
		productSlug: productSlug(row.productSlug),
		purchaseCreatedAt: row.purchaseCreatedAt,
		couponMaxUses: row.couponMaxUses ?? null,
		couponUsedCount: row.couponUsedCount ?? null,
	}
}

/**
 * Builds the deduplicated list of TeamKitProjectionContact records from raw
 * owner and member purchase rows.  Contacts with missing or mismatched data
 * are collected in the skipped array instead of being returned.
 *
 * @param args.ownerPurchases - Purchase rows where the buyer is a team owner
 * @param args.memberPurchases - Purchase rows where the buyer is a team member
 * @param args.skipped - Mutable array; ineligible rows are appended here
 * @returns Deduplicated contacts ready for Kit projection
 */
export function buildTeamKitProjectionContacts(args: {
	ownerPurchases: TeamPurchaseRow[]
	memberPurchases: TeamPurchaseRow[]
	skipped: TeamKitProjectionSkipped[]
}): TeamKitProjectionContact[] {
	const contacts = new Map<
		string,
		{
			email: string
			name?: string | null
			userId?: string | null
			ownerTeamIds: Set<string>
			memberTeamIds: Set<string>
			teamFacts: Map<string, { seatCount: number; usedSeatCount: number }>
			latest?: TeamPurchaseRow
		}
	>()

	for (const row of args.ownerPurchases) {
		addRow({ contacts, row, role: 'owner', skipped: args.skipped })
	}
	for (const row of args.memberPurchases) {
		addRow({ contacts, row, role: 'member', skipped: args.skipped })
	}

	return [...contacts.entries()]
		.map(([contactKey, contact]) => {
			const ownerTeamIds = [...contact.ownerTeamIds].sort()
			const memberTeamIds = [...contact.memberTeamIds].sort()
			const teamIds = [...new Set([...ownerTeamIds, ...memberTeamIds])].sort()
			const role = roleFor({ ownerTeamIds, memberTeamIds })
			const seatCount = teamIds.reduce(
				(count, teamId) =>
					count + (contact.teamFacts.get(teamId)?.seatCount ?? 0),
				0,
			)
			const usedSeatCount = teamIds.reduce(
				(count, teamId) =>
					count + (contact.teamFacts.get(teamId)?.usedSeatCount ?? 0),
				0,
			)
			const latest = contact.latest
			const latestTeamId = latest?.teamId ?? teamIds[0] ?? ''
			const latestProduct = latest?.productSlug ?? latest?.productId ?? ''
			const latestPurchaseAt = latest ? toIso(latest.purchaseCreatedAt) : ''
			const fields: TeamKitProjectionFields = {
				aih_team_role: role,
				aih_team_ids: teamIds.join('|'),
				aih_team_latest_team_id: latestTeamId,
				aih_team_seat_count: String(seatCount),
				aih_team_used_seat_count: String(usedSeatCount),
				aih_team_latest_product: latestProduct,
				aih_team_latest_purchase_at: latestPurchaseAt,
			}
			return {
				contactKey,
				email: contact.email,
				name: contact.name,
				userId: contact.userId,
				role,
				teamIds,
				ownerTeamIds,
				memberTeamIds,
				seatCount,
				usedSeatCount,
				latestTeamId,
				latestProduct,
				latestPurchaseAt,
				fields,
			}
		})
		.sort((left, right) =>
			right.latestPurchaseAt.localeCompare(left.latestPurchaseAt),
		)
}

function addRow(args: {
	contacts: Map<
		string,
		{
			email: string
			name?: string | null
			userId?: string | null
			ownerTeamIds: Set<string>
			memberTeamIds: Set<string>
			teamFacts: Map<string, { seatCount: number; usedSeatCount: number }>
			latest?: TeamPurchaseRow
		}
	>
	row: TeamPurchaseRow
	role: 'owner' | 'member'
	skipped: TeamKitProjectionSkipped[]
}) {
	const email = normalizeEmail(args.row.email)
	if (!email) {
		args.skipped.push({
			reason: 'missing-email',
			purchaseId: args.row.purchaseId,
			userId: args.row.userId,
			teamId: args.row.teamId,
		})
		return
	}
	if (!args.row.teamId) {
		args.skipped.push({
			reason: 'missing-team-id',
			purchaseId: args.row.purchaseId,
			userId: args.row.userId,
		})
		return
	}
	const existing = args.contacts.get(email) ?? {
		email,
		name: args.row.name,
		userId: args.row.userId,
		ownerTeamIds: new Set<string>(),
		memberTeamIds: new Set<string>(),
		teamFacts: new Map<string, { seatCount: number; usedSeatCount: number }>(),
	}
	if (args.role === 'owner') existing.ownerTeamIds.add(args.row.teamId)
	if (args.role === 'member') existing.memberTeamIds.add(args.row.teamId)
	existing.teamFacts.set(args.row.teamId, {
		seatCount: Math.max(0, args.row.couponMaxUses ?? 0),
		usedSeatCount: Math.max(0, args.row.couponUsedCount ?? 0),
	})
	if (
		!existing.latest ||
		toIso(args.row.purchaseCreatedAt) > toIso(existing.latest.purchaseCreatedAt)
	) {
		existing.latest = args.row
	}
	args.contacts.set(email, existing)
}

async function previewOrWriteKitProjection(args: {
	contacts: TeamKitProjectionContact[]
	provider: TeamKitProjectionProvider
	allowWrite: boolean
	ownerTagId?: string | number
	memberTagId?: string | number
	lookupDelayMs?: number
	lookupMaxAttempts?: number
}): Promise<TeamKitProjectionKitReceipt[]> {
	const receipts: TeamKitProjectionKitReceipt[] = []
	const lookupMaxAttempts = Math.max(1, args.lookupMaxAttempts ?? 1)
	for (const [index, contact] of args.contacts.entries()) {
		if (index > 0 && args.lookupDelayMs && args.lookupDelayMs > 0) {
			await sleep(args.lookupDelayMs)
		}
		const tags = tagsForRole(contact.role)
		let subscriber: { id: string | number } | null = null
		try {
			subscriber = await lookupSubscriberWithRetry({
				provider: args.provider,
				email: contact.email,
				maxAttempts: lookupMaxAttempts,
				baseDelayMs: args.lookupDelayMs ?? 0,
			})
		} catch (error) {
			receipts.push({
				email: contact.email,
				subscriberFound: false,
				fieldWriteAttempted: false,
				fieldWritePerformed: false,
				tagWriteAttempted: false,
				tagWritePerformed: false,
				tags,
				reasons: [
					`kit-subscriber-lookup-failed:${error instanceof Error ? error.message : String(error)}`,
				],
			})
			continue
		}
		const receipt: TeamKitProjectionKitReceipt = {
			email: contact.email,
			subscriberFound: Boolean(subscriber?.id),
			subscriberId: subscriber?.id ? String(subscriber.id) : undefined,
			fieldWriteAttempted: false,
			fieldWritePerformed: false,
			tagWriteAttempted: false,
			tagWritePerformed: false,
			tags,
			reasons: [],
		}
		if (!subscriber?.id) {
			receipt.reasons.push('kit-subscriber-not-found')
			receipts.push(receipt)
			continue
		}
		if (!args.allowWrite) {
			receipts.push(receipt)
			continue
		}
		if (args.provider.updateSubscriberFields) {
			receipt.fieldWriteAttempted = true
			try {
				await args.provider.updateSubscriberFields({
					subscriberId: String(subscriber.id),
					fields: contact.fields,
				})
				receipt.fieldWritePerformed = true
			} catch (error) {
				receipt.reasons.push(
					`kit-field-write-failed:${error instanceof Error ? error.message : String(error)}`,
				)
			}
		} else {
			receipt.reasons.push('kit-field-update-not-supported')
		}
		const tagIds = tagIdsForRole({
			role: contact.role,
			ownerTagId: args.ownerTagId,
			memberTagId: args.memberTagId,
		})
		if (tagIds.length && args.provider.subscribeToList) {
			receipt.tagWriteAttempted = true
			let tagFailures = 0
			for (const tagId of tagIds) {
				try {
					await args.provider.subscribeToList({
						listId: tagId,
						listType: 'tag',
						user: {
							id: contact.userId ?? contact.email,
							email: contact.email,
							emailVerified: null,
							name: contact.name,
						},
						fields: {},
					})
				} catch (error) {
					tagFailures += 1
					receipt.reasons.push(
						`kit-tag-write-failed:${tagId}:${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}
			receipt.tagWritePerformed = tagFailures === 0
		} else if (tags.length) {
			receipt.reasons.push('kit-tag-write-not-configured')
		}
		receipts.push(receipt)
	}
	return receipts
}

function requireDatabase(
	database?: TeamKitProjectionDatabase,
): TeamKitProjectionDatabase {
	if (!database)
		throw new Error(
			'Team Kit projection requires a database or explicit purchase rows',
		)
	return database
}

function roleFor(args: {
	ownerTeamIds: string[]
	memberTeamIds: string[]
}): TeamKitRole {
	if (args.ownerTeamIds.length && args.memberTeamIds.length)
		return 'owner_member'
	if (args.ownerTeamIds.length) return 'owner'
	if (args.memberTeamIds.length) return 'member'
	return 'none'
}

function tagsForRole(role: TeamKitRole) {
	if (role === 'owner_member')
		return [TEAM_KIT_OWNER_TAG_NAME, TEAM_KIT_MEMBER_TAG_NAME]
	if (role === 'owner') return [TEAM_KIT_OWNER_TAG_NAME]
	if (role === 'member') return [TEAM_KIT_MEMBER_TAG_NAME]
	return []
}

async function lookupSubscriberWithRetry(args: {
	provider: TeamKitProjectionProvider
	email: string
	maxAttempts: number
	baseDelayMs: number
}) {
	let lastError: unknown
	for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
		try {
			return await args.provider.getSubscriberByEmail(args.email)
		} catch (error) {
			lastError = error
			if (attempt >= args.maxAttempts) break
			await sleep(Math.max(args.baseDelayMs, 250) * attempt)
		}
	}
	throw lastError
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function tagIdsForRole(args: {
	role: TeamKitRole
	ownerTagId?: string | number
	memberTagId?: string | number
}) {
	const ids: (string | number)[] = []
	if (
		(args.role === 'owner' || args.role === 'owner_member') &&
		args.ownerTagId
	) {
		ids.push(args.ownerTagId)
	}
	if (
		(args.role === 'member' || args.role === 'owner_member') &&
		args.memberTagId
	) {
		ids.push(args.memberTagId)
	}
	return ids
}

function productSlug(value: unknown) {
	if (value && typeof value === 'object' && 'slug' in value) {
		const slug = (value as { slug?: unknown }).slug
		if (typeof slug === 'string' && slug.trim()) return slug.trim()
	}
	return null
}

function toIso(value: Date | string) {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString()
}

function normalizeEmail(value?: string | null) {
	const normalized = value?.trim().toLowerCase()
	return normalized && normalized.includes('@') ? normalized : undefined
}
