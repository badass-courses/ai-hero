import { describe, it, expect } from 'vitest'
import { preparationFixture } from './message-preparation.fixtures'
import {
	compileMessageTemplate,
	preparationHash,
	preparationNamespace,
	preparationSnapshotSchema,
	preparationState,
} from './message-preparation'
import {
	preparationEventRow,
	decodePreparationEvent,
} from './message-preparation-store'

describe('bounded immutable message preparation', () => {
	it('escapes values and binds stable Liquid to full revision and slot', () => {
		const f = preparationFixture(),
			t = f.templates[0]!,
			c = compileMessageTemplate(t, { FIRST_NAME: '<Ada & "Lee">' })
		expect(c.html).toContain('&lt;Ada &amp; &quot;Lee&quot;&gt;')
		expect(c.liquid).not.toContain('Ada')
		expect(Object.keys(c.fields)).toEqual([`${c.namespace}_first_name`])
		expect(preparationNamespace(t.revision, 'B2')).not.toBe(c.namespace)
		expect(
			preparationNamespace({ ...t.revision, contentRevision: 'changed' }, 'B1'),
		).not.toBe(c.namespace)
	})
	it('preserves exact reviewed query-bearing image URLs and escapes token attributes', () => {
		const url =
			'https://example.test/api/og?resource=synthetic-feature-build&updatedAt=2026-03-20T09:48:53.260Z'
		const base = preparationFixture().templates[0]!
		const links = { FEATURE_BUILD_IMAGE_URL: url }
		for (const src of ['$FEATURE_BUILD_IMAGE_URL', url]) {
			const html = `<p>$FIRST_NAME</p><img src="${src}" alt="Synthetic feature">`
			const result = compileMessageTemplate(
				{ ...base, html, htmlHash: preparationHash(html), links },
				{ FIRST_NAME: 'there' },
			)
			expect(result.html).toContain(
				src.startsWith('$') ? url.replace('&', '&amp;') : url,
			)
		}
		const html = `<p>$FIRST_NAME</p><img src="${url.replace('synthetic-feature-build', 'unreviewed')}" alt="Synthetic">`
		expect(() =>
			compileMessageTemplate(
				{ ...base, html, htmlHash: preparationHash(html), links },
				{ FIRST_NAME: 'there' },
			),
		).toThrow('Unreviewed literal URL')
	})
	it.each([
		'http://example.test/api/og?resource=synthetic',
		'https://user:secret@example.test/api/og?resource=synthetic',
		' https://example.test/api/og?resource=synthetic',
		'https://example.test/api/og?resource=synthetic#fragment',
	])('keeps image URL safety checks for %s', (url) => {
		const html =
			'<p>$FIRST_NAME</p><img src="$FEATURE_BUILD_IMAGE_URL" alt="Synthetic">'
		const template = {
			...preparationFixture().templates[0]!,
			html,
			htmlHash: preparationHash(html),
			links: { FEATURE_BUILD_IMAGE_URL: url },
		}
		expect(() =>
			compileMessageTemplate(template, { FIRST_NAME: 'there' }),
		).toThrow('Unreviewable message URL')
	})
	it.each(['OFFER_PRICE', 'UNKNOWN', 'FIRST_NAME_BAD'])(
		'rejects unapproved token %s',
		(token) => {
			const t = {
				...preparationFixture().templates[0]!,
				html: `<p>$${token}</p>`,
			}
			t.htmlHash = preparationHash(t.html)
			expect(() => compileMessageTemplate(t, { FIRST_NAME: 'there' })).toThrow(
				'Unknown message token',
			)
		},
	)
	it.each([
		'http://example.test/',
		'https://user:secret@example.test/',
		'javascript:alert(1)',
		'https://example.test/?coupon=secret',
	])('rejects unsafe link %s', (url) => {
		const t = {
			...preparationFixture().templates[0]!,
			links: { OFFER_URL: url },
		}
		expect(() => compileMessageTemplate(t, { FIRST_NAME: 'there' })).toThrow()
	})
	it('refuses missing values, bad hashes, preexisting Liquid and counterfeit revision', () => {
		const t = preparationFixture().templates[0]!
		expect(() => compileMessageTemplate(t, {})).toThrow()
		expect(() =>
			compileMessageTemplate(
				{ ...t, htmlHash: '0'.repeat(64) },
				{ FIRST_NAME: 'there' },
			),
		).toThrow()
		const html = '<p>{{ subscriber.global }}</p>'
		expect(() =>
			compileMessageTemplate(
				{ ...t, html, htmlHash: preparationHash(html) },
				{ FIRST_NAME: 'there' },
			),
		).toThrow()
		expect(() =>
			compileMessageTemplate(
				{ ...t, revision: { ...t.revision, contentRevision: 'fake' } },
				{ FIRST_NAME: 'there' },
			),
		).toThrow()
	})
	it('strict event codec refuses envelope/payload mutations', () => {
		const s = preparationFixture().snapshot,
			row = preparationEventRow({
				version: 1,
				stage: 'snapshot',
				observedAt: s.preparedAt,
				snapshot: s,
			})
		expect(decodePreparationEvent(row)).not.toBeNull()
		for (const change of [
			{ contactId: 'other' },
			{ provider: 'kit' },
			{ schemaVersion: 2 },
			{ payloadSummary: { ...row.payloadSummary, unknown: true } },
			{ semanticIdempotencyKey: 'wrong' },
		])
			expect(decodePreparationEvent({ ...row, ...change })).toBeNull()
		expect(
			preparationSnapshotSchema.safeParse({
				...s,
				fields: { mutable_name: 'bad' },
			}).success,
		).toBe(false)
	})
	it('lifecycle cannot jump directly to enrollment', () => {
		expect(preparationState(['ENROLLMENT'])).toBe('unprepared')
		expect(
			preparationState(['SNAPSHOT', 'FIELDS', 'READBACK', 'ENROLLMENT']),
		).toBe('enrollment')
		expect(preparationState(['SNAPSHOT', 'FIELDS', 'HOLD', 'READBACK'])).toBe(
			'held',
		)
	})
})
