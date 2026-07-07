import type { AttachedEmail } from '@coursebuilder/ui/cms/manifest'

/**
 * Map an attached-email join row (its `email` resource + join `metadata`) to the
 * `AttachedEmail` shape `EmailsField` renders. Shared by the event and cohort
 * CMS list actions so the schedule/policy-derivation rules can't drift between
 * them (both metadata types — `event-reminder` / `cohort-reminder` — store the
 * same policy fields on the join row).
 */
export function toAttachedEmail(
	resource: { id: string; fields?: Record<string, any> | null },
	metadata: Record<string, any> | null | undefined,
): AttachedEmail {
	const fields = (resource.fields ?? {}) as Record<string, any>
	const md = (metadata ?? {}) as Record<string, any>
	// `Number.isFinite` (not `typeof === 'number'`) so a corrupted NaN/Infinity in
	// the join row can't resolve to a "scheduled" reminder the sender then skips.
	const hoursInAdvance = Number.isFinite(md.hoursInAdvance)
		? (md.hoursInAdvance as number)
		: undefined
	const sendAt = typeof md.sendAt === 'string' ? md.sendAt : null
	// Honor an explicitly stored policy ONLY when it's legal AND consistent with
	// the field it implies — 'at' needs a real `sendAt`, 'relative' needs a real
	// `hoursInAdvance` (a fired send stamps `policy: null`). A missing/corrupted or
	// self-inconsistent value (e.g. 'at' with no `sendAt`) is re-derived rather
	// than trusted: exact `sendAt` → 'at', else `hoursInAdvance` → 'relative', else
	// nothing scheduled — never a "scheduled" row with no time.
	const stored = md.policy
	const storedIsValid =
		(stored === 'at' && sendAt !== null) ||
		(stored === 'relative' && hoursInAdvance !== undefined) ||
		stored === null
	const policy: AttachedEmail['policy'] = storedIsValid
		? stored
		: sendAt
			? 'at'
			: hoursInAdvance !== undefined
				? 'relative'
				: null
	return {
		emailId: resource.id,
		title: fields.title ?? resource.id,
		href: fields.slug ? `/admin/emails/${fields.slug}/edit` : undefined,
		// Content for the in-place "Edit email" dialog prefill.
		subject: typeof fields.subject === 'string' ? fields.subject : undefined,
		body: typeof fields.body === 'string' ? fields.body : undefined,
		// Gate the schedule fields on the resolved policy so a cleared row reads
		// as "Not scheduled" rather than surfacing a stale time.
		hoursInAdvance: policy === 'relative' ? hoursInAdvance : undefined,
		sendAt: policy === 'at' ? sendAt : null,
		policy,
		sends: Array.isArray(md.sends) ? md.sends : [],
	}
}
