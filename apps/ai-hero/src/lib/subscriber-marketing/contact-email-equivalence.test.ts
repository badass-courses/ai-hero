import { createHmac, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { CONTACT_EMAIL_STALE_SQL } from './contact-email-key-contract'
import { describe, expect, it } from 'vitest'
import { emailFingerprint } from './evergreen-offer-journey/verified-owner-evidence'
import {
	normalizeEmail,
	assertEmailKeyRuntime,
	emailEquivalenceKey,
	contactEmailWriteValues,
	isStoredEmail,
	isNormalizedEmail,
} from './contact-email-equivalence'

describe('exact Contact email projection', () => {
	it('keeps the migration PLAN identical to the versioned generated contract', async () => {
		const plan = await fs.readFile(
			new URL(
				'../../db/migrations/plans/20260908_contact_email_equivalence.sql',
				import.meta.url,
			),
			'utf8',
		)
		expect(plan).toContain(CONTACT_EMAIL_STALE_SQL)
	})
	it('pins normalization/HMAC/key goldens and refuses unproved runtime Unicode changes', () => {
		expect(normalizeEmail(' ΟΣ@example.test ')).toBe('ος@example.test')
		expect(normalizeEmail('İ@example.test')).toBe('i\u0307@example.test')
		expect(normalizeEmail('K@example.test')).toBe('k@example.test')
		expect(emailFingerprint('fixture', ' ΟΣ@example.test ')).toBe(
			'fe971d86fb55dfdcadc75fd7da4849bb6d9edfa339ff771271c02b2fd2e06267',
		)
		expect(emailEquivalenceKey(' ΟΣ@example.test ')).toBe(
			'v1:eb79e48f9e2d78cbd4a1e2e18a2bb5c24da8ed072117ef36c5ea26a39dd787b9',
		)
		expect(() =>
			assertEmailKeyRuntime({ node: '24.18.0', unicode: '17.0' }),
		).not.toThrow()
		expect(() =>
			assertEmailKeyRuntime({ node: '24.18.0', unicode: '16.0' }),
		).toThrow()
		expect(() =>
			assertEmailKeyRuntime({ node: '22.0.0', unicode: '17.0' }),
		).toThrow()
	})
	const whitespace =
		'\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
	it('preserves exact JS normalization and legacy HMAC bytes across the identifier domain', () => {
		for (const raw of [
			'User/X!@Example.test',
			'ΟΣ@example.test',
			'İ@example.test',
			'K@example.test',
			'é@example.test',
			'e\u0301@example.test',
			...Array.from(whitespace, (c) => `${c}USER@example.test${c}`),
			'İ'.repeat(240) + '@example.test',
		]) {
			expect(normalizeEmail(raw)).toBe(raw.trim().toLowerCase())
			const legacy = createHmac('sha256', 'fixture')
				.update(
					JSON.stringify([
						'aih:owner-proof:email:v1',
						raw.trim().toLowerCase(),
					]),
				)
				.digest('hex')
			const shared = createHmac('sha256', 'fixture')
				.update(
					JSON.stringify(['aih:owner-proof:email:v1', normalizeEmail(raw)]),
				)
				.digest('hex')
			expect(shared).toBe(legacy)
			expect(emailFingerprint('fixture', raw)).toBe(legacy)
			expect(emailEquivalenceKey(raw)).toBe(
				emailEquivalenceKey(normalizeEmail(raw)),
			)
		}
	})
	it('pins version, serialization and raw UTF-8 source independently', () => {
		const raw = ' İ@example.test '
		expect(emailEquivalenceKey(raw)).toBe(
			'v1:' +
				createHash('sha256')
					.update(
						JSON.stringify(['aih:contact-email:v1', raw.trim().toLowerCase()]),
						'utf8',
					)
					.digest('hex'),
		)
		expect(emailEquivalenceKey(raw)).toHaveLength(67)
		expect(contactEmailWriteValues(raw)).toEqual({
			email: raw,
			emailKey: emailEquivalenceKey(raw),
			emailKeySource: createHash('sha256').update(raw, 'utf8').digest('hex'),
		})
		expect(contactEmailWriteValues(null)).toEqual({
			email: null,
			emailKey: null,
			emailKeySource: null,
		})
		expect(emailEquivalenceKey('é@example.test')).not.toBe(
			emailEquivalenceKey('e\u0301@example.test'),
		)
	})
	it('bounds raw storage by Unicode code points, not UTF-16 units or email grammar', () => {
		for (const raw of [
			'a!b/x@example.test',
			'"quoted"@example.test',
			'用户@例子.test',
			'𐐀'.repeat(255),
			'İ'.repeat(255),
		])
			expect(isStoredEmail(raw)).toBe(true)
		expect(isStoredEmail('𐐀'.repeat(256))).toBe(false)
		for (const raw of [
			'',
			' \t ',
			'\ud800@example.test',
			'\udc00@example.test',
		])
			expect(isStoredEmail(raw)).toBe(false)
		const raw = 'İ'.repeat(255)
		expect(normalizeEmail(raw).length).toBe(510)
		expect(isNormalizedEmail(normalizeEmail(raw))).toBe(true)
		expect(isNormalizedEmail('x'.repeat(1021))).toBe(false)
	})
})
