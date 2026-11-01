import { emailEquivalenceKey } from './contact-email-equivalence'
import type { DrovrListState } from './drovr-list-state'

export const CONFIRM_RECONCILER_OFF_KIT_FLAG =
	'AIH_CONFIRM_RECONCILER_OFF_KIT_ENABLED'

export function confirmationReconcilerOffKitEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	return env[CONFIRM_RECONCILER_OFF_KIT_FLAG] === 'true'
}

/** Persisted intake evidence, not today's DROVR_DOI_FORMS setting. */
export type DrovrConfirmationSubject = {
	contactId: string
	emailKey: string | null
	requestedAt: string
}

export function legacyKitConfirmationSubscribers<T extends { email: string }>(
	subscribers: readonly T[],
	owned: readonly DrovrConfirmationSubject[],
): T[] {
	const ownedKeys = new Set(owned.map((row) => row.emailKey).filter(Boolean))
	return subscribers.filter(
		(row) => !ownedKeys.has(emailEquivalenceKey(row.email)),
	)
}

/**
 * DOI enrolment is already owed atomically by drovr's confirm batch. This
 * observes consent, not a second enrolment pipeline: confirm.fold and the
 * drovr outbox drain own repair even when Kit is unreachable. Unknowns
 * remain pending and are read again; nothing here marks a signup done.
 */
export async function reconcileDrovrConfirmations(args: {
	subjects: readonly DrovrConfirmationSubject[]
	window: { from: string; to: string }
	read: (contactId: string) => Promise<DrovrListState | null>
}) {
	const subjects = args.subjects.filter((row) => {
		const at = Date.parse(row.requestedAt)
		return (
			at >= Date.parse(args.window.from) && at <= Date.parse(args.window.to)
		)
	})
	// Bound reads without dropping older subjects: rotate every poll. The
	// daily tier also covers requests outside the recent window.
	const cap = 50
	const offset = subjects.length
		? (Math.floor(Date.parse(args.window.to) / 900_000) * cap) % subjects.length
		: 0
	const selected = [
		...subjects.slice(offset),
		...subjects.slice(0, offset),
	].slice(0, cap)
	const counts = {
		selected: selected.length,
		confirmed: 0,
		unconfirmed: 0,
		stopped: 0,
		unknown: 0,
		deferred: subjects.length - selected.length,
	}
	for (const subject of selected) {
		let state: DrovrListState | null
		try {
			state = await args.read(subject.contactId)
		} catch {
			state = null
		}
		if (!state || state.contactId !== subject.contactId) counts.unknown += 1
		else if (
			state.state === 'stopped' ||
			state.stops.some((stop) =>
				['all', 'value-path-skills-course'].includes(stop.scope),
			)
		)
			counts.stopped += 1
		else if (
			state.forms.some(
				(form) =>
					form.formId === 'skills-newsletter' && form.state === 'confirmed',
			)
		)
			counts.confirmed += 1
		else if (
			state.forms.some(
				(form) =>
					form.formId === 'skills-newsletter' && form.state === 'unconfirmed',
			)
		)
			counts.unconfirmed += 1
		else counts.unknown += 1
	}
	return { owner: 'drovr-confirm-fold-and-outbox' as const, counts }
}
