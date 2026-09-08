import { createHmac, createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emailFingerprint } from './evergreen-offer-journey/verified-owner-evidence'
import {
	normalizeEmail,
	emailEquivalenceKey,
	contactEmailWriteValues,
	isStoredEmail,
	isNormalizedEmail,
} from './contact-email-equivalence'

describe('exact Contact email projection', () => {
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
