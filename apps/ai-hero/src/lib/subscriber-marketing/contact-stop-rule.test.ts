import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
	activeContactStops,
	activeContactStopsByKey,
	firstActiveStop,
	readActiveContactStops,
	stopSignalOfEvent,
	type ContactStopSignal,
} from './contact-stop-rule'

const unsub = (at: string): ContactStopSignal => ({ kind: 'unsubscribed', at })
const lift = (at: string): ContactStopSignal => ({ kind: 'resubscribed', at })

describe('the contact stop rule', () => {
	it('keeps an unsubscribe active with no lift', () => {
		expect(activeContactStops([unsub('2026-09-01T00:00:00Z')])).toEqual({
			unsubscribed: true,
			bounced: false,
			complained: false,
		})
	})

	it('lifts an unsubscribe with a later fresh double opt-in', () => {
		expect(
			activeContactStops([
				unsub('2026-09-01T00:00:00Z'),
				lift('2026-09-02T00:00:00Z'),
			]).unsubscribed,
		).toBe(false)
	})

	it('applies a later unsubscribe again', () => {
		expect(
			activeContactStops([
				unsub('2026-09-01T00:00:00Z'),
				lift('2026-09-02T00:00:00Z'),
				unsub('2026-09-03T00:00:00Z'),
			]).unsubscribed,
		).toBe(true)
	})

	it('keeps a tie stopped: a stop fact wins (whole seconds, as MySQL stores them)', () => {
		expect(
			activeContactStops([
				unsub('2026-09-02T00:00:00Z'),
				lift('2026-09-02T00:00:00Z'),
			]).unsubscribed,
		).toBe(true)
		// An unsubscribe later in the same second as the confirmation.
		expect(
			activeContactStops([
				lift('2026-09-02T00:00:00.400Z'),
				unsub('2026-09-02T00:00:00.900Z'),
			]).unsubscribed,
		).toBe(true)
		// Stored truncated: the same second, still stopped.
		expect(
			activeContactStops([
				unsub('2026-09-02T00:00:00.000Z'),
				lift('2026-09-02T00:00:00.400Z'),
			]).unsubscribed,
		).toBe(true)
		expect(
			activeContactStops([
				unsub('2026-09-02T00:00:00.900Z'),
				lift('2026-09-02T00:00:01.000Z'),
			]).unsubscribed,
		).toBe(false)
	})

	it('never lets a lift revive work planned before it', () => {
		const signals = [
			unsub('2026-09-02T00:00:00Z'),
			lift('2026-09-05T00:00:00Z'),
		]
		expect(
			activeContactStops(signals, '2026-09-01T00:00:00Z').unsubscribed,
		).toBe(true)
		expect(
			activeContactStops(signals, '2026-09-03T00:00:00Z').unsubscribed,
		).toBe(true)
		expect(
			activeContactStops(signals, '2026-09-05T00:00:00Z').unsubscribed,
		).toBe(false)
		expect(
			activeContactStops(signals, '2026-09-06T00:00:00Z').unsubscribed,
		).toBe(false)
		// No unsubscribe: planning time changes nothing.
		expect(
			activeContactStops([lift('2026-09-05T00:00:00Z')], '2026-09-01T00:00:00Z')
				.unsubscribed,
		).toBe(false)
	})

	it('does not lift with an earlier lift or an unreadable time', () => {
		expect(
			activeContactStops([
				lift('2026-09-01T00:00:00Z'),
				unsub('2026-09-02T00:00:00Z'),
			]).unsubscribed,
		).toBe(true)
		expect(
			activeContactStops([unsub('garbage'), lift('2026-09-02T00:00:00Z')])
				.unsubscribed,
		).toBe(true)
		expect(
			activeContactStops([unsub('2026-09-01T00:00:00Z'), lift('garbage')])
				.unsubscribed,
		).toBe(true)
	})

	it('never lifts a bounce or a complaint', () => {
		const stops = activeContactStops([
			{ kind: 'bounced', at: '2026-09-01T00:00:00Z' },
			{ kind: 'complained', at: '2026-09-01T00:00:00Z' },
			lift('2026-09-02T00:00:00Z'),
		])
		expect(stops).toEqual({
			unsubscribed: false,
			bounced: true,
			complained: true,
		})
		expect(firstActiveStop(stops)).toBe('bounced')
	})

	it('reads events, Dates and the lift type; ignores other types', () => {
		expect(
			stopSignalOfEvent({
				eventType: 'contact.resubscribed',
				occurredAt: new Date('2026-09-02T00:00:00Z'),
			}),
		).toEqual(lift('2026-09-02T00:00:00.000Z'))
		expect(
			stopSignalOfEvent({
				eventType: 'journey.owner.assigned',
				occurredAt: '',
			}),
		).toBeUndefined()
	})

	it('reads one contact through findContactEventsByType', async () => {
		const events: Record<string, { occurredAt: string }[]> = {
			'contact.unsubscribed': [{ occurredAt: '2026-09-01T00:00:00Z' }],
			'contact.resubscribed': [{ occurredAt: '2026-09-02T00:00:00Z' }],
		}
		const stops = await readActiveContactStops(
			{
				findContactEventsByType: (_, type) =>
					(events[type] ?? []).map((event) => ({
						...event,
						eventType: type,
					})) as never,
			},
			'c1',
		)
		expect(stops.unsubscribed).toBe(false)
	})

	it('applies per key over batch rows', () => {
		const byKey = activeContactStopsByKey([
			{ key: 'a', signal: unsub('2026-09-01T00:00:00Z') },
			{ key: 'a', signal: lift('2026-09-02T00:00:00Z') },
			{ key: 'b', signal: unsub('2026-09-01T00:00:00Z') },
			{ key: 'c', signal: undefined },
		])
		expect(byKey.get('a')?.unsubscribed).toBe(false)
		expect(byKey.get('b')?.unsubscribed).toBe(true)
		expect(byKey.has('c')).toBe(false)
	})
})

/**
 * The pin: a stop ContactEvent type written as a literal is how a reader
 * treats an unsubscribe as permanent. Only these files may name one; every
 * reader imports the rule's constants and applies the rule instead.
 */
const LITERAL_ALLOWED: Record<string, string> = {
	'lib/subscriber-marketing/contact-stop-rule.ts': 'the rule itself',
	'app/api/kit/webhook/route.ts': 'writer: maps Kit webhooks to stop events',
	'lib/subscriber-marketing/lifecycle-contact-events.ts':
		'writer: records contact.unsubscribed',
	'lib/subscriber-marketing/drovr-shadow-emitter.ts':
		'mapper: stop events to drovr facts',
	'lib/subscriber-marketing/drovr-stop-verdict.ts':
		'mapper: which drovr facts are directory stops (row 204c)',
	'lib/subscriber-marketing/drovr-outbox.ts':
		'gate: which outbox rows are stops later rows wait behind (row 204b)',
	'lib/subscriber-marketing/contact-sync-reconcile.ts':
		'mapper: which events carry a stop fact to drovr',
	'lib/subscriber-marketing/contact-sync-backfill.ts':
		'dispatch: backfill phases named by event type',
	'lib/subscriber-marketing/email-course/parity-receipt.ts':
		'report: parity labels',
	'scripts/backfill-contact-events.ts': 'writer: one-time backfill',
}

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const STOP_LITERAL =
	/['"]contact\.(?:unsubscribed|bounced|complained|resubscribed)['"]/

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory())
			return entry.name === 'node_modules' ? [] : sourceFiles(full)
		return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
			? [full]
			: []
	})
}

describe('the contact stop rule pin', () => {
	it('lets no reader name a stop event type outside the allowlist', () => {
		const offenders = sourceFiles(SRC)
			.map((file) => path.relative(SRC, file).split(path.sep).join('/'))
			.filter(
				(file) =>
					!(file in LITERAL_ALLOWED) &&
					STOP_LITERAL.test(fs.readFileSync(path.join(SRC, file), 'utf8')),
			)
		expect(offenders).toEqual([])
	})

	it('lets no reader use the stop constants or intent stop flags without the rule', () => {
		// Textual, like the literal pin: it catches the plain forms (a stop
		// constant or a provider flag read in a file that never applies the
		// rule), not every indirection. Projections that only carry the data
		// to a rule-applying reader are listed with the reason.
		const projectionOnly: Record<string, string> = {
			'lib/subscriber-marketing/drizzle-capture-repository.ts':
				'projection: loads stop events and intent flags for learner-flow-classifier',
		}
		const stopConstant =
			/\bCONTACT_(?:UNSUBSCRIBED|BOUNCED|COMPLAINED|RESUBSCRIBED)_EVENT_TYPE\b|\bCONTACT_STOP(?:_RULE)?_EVENT_TYPES\b/
		const intentFlag =
			/providerResult[\s\S]{0,400}(?:unsubscribed|bounced|complained)|(?:unsubscribed|bounced|complained)[\s\S]{0,400}providerResult/
		const appliesRule =
			/\b(?:readActiveContactStops|activeContactStops|activeContactStopsByKey|readContactStopSignals|stopSignalsOfIntents)\b/
		const offenders = sourceFiles(SRC)
			.map((file) => path.relative(SRC, file).split(path.sep).join('/'))
			.filter((file) => {
				if (file in LITERAL_ALLOWED || file in projectionOnly) return false
				const source = fs.readFileSync(path.join(SRC, file), 'utf8')
				return (
					(stopConstant.test(source) || intentFlag.test(source)) &&
					!appliesRule.test(source)
				)
			})
		expect(offenders).toEqual([])
	})

	it.each([
		'lib/subscriber-marketing/learner-flow-classifier.ts',
		'lib/subscriber-marketing/drovr-personalize.ts',
		'lib/subscriber-marketing/drovr-evergreen-sender.ts',
		'lib/subscriber-marketing/value-path-email-executor.ts',
		'lib/subscriber-marketing/owner-birth-guard-drizzle.ts',
		'lib/subscriber-marketing/drovr-ownership-live.ts',
		'lib/subscriber-marketing/signup-confirmation-reconciler.server.ts',
	])('%s applies the shared rule', (file) => {
		const source = fs.readFileSync(path.join(SRC, file), 'utf8')
		expect(source).toMatch(/contact-stop-rule'/)
		expect(source).toMatch(
			/readActiveContactStops|activeContactStopsByKey|activeContactStops\(/,
		)
	})
})
