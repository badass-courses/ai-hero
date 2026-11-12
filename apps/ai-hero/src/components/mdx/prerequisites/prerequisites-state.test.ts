import { describe, expect, it } from 'vitest'

import { readRemembered, writeRemembered } from './prerequisites-state'

describe('prerequisites cookie state', () => {
	it('round-trips a hidden choice and the done flag', () => {
		const value = writeRemembered(undefined, 'lesson_a', {
			collapsed: true,
			done: true,
		})
		expect(value).toBe('lesson_a~hd')
		expect(readRemembered(value, 'lesson_a')).toEqual({
			collapsed: true,
			done: true,
		})
	})

	it('keeps an explicit expanded choice distinct from no choice', () => {
		const shown = writeRemembered('', 'a', { collapsed: false, done: true })
		expect(readRemembered(shown, 'a')).toEqual({ collapsed: false, done: true })
		const none = writeRemembered('', 'a', { done: false })
		expect(readRemembered(none, 'a')).toEqual({
			collapsed: undefined,
			done: false,
		})
	})

	it('returns nothing for an unknown lesson or a missing cookie', () => {
		expect(readRemembered('a~h', 'b')).toEqual({})
		expect(readRemembered(undefined, 'a')).toEqual({})
	})

	it('moves the touched lesson first and keeps the others', () => {
		const value = writeRemembered('a~h!b~d!c~s', 'b', { collapsed: true })
		expect(value).toBe('b~h!a~h!c~s')
	})

	it('caps the cookie at 40 lessons, dropping the least recent', () => {
		let value = ''
		for (let i = 0; i < 45; i++) value = writeRemembered(value, `l${i}`, { done: true })
		const ids = value.split('!').map((entry) => entry.split('~')[0])
		expect(ids).toHaveLength(40)
		expect(ids[0]).toBe('l44')
		expect(ids).not.toContain('l4')
		expect(encodeURIComponent(value)).toBe(value)
	})

	it('ignores malformed entries and refuses unsafe ids', () => {
		expect(readRemembered('a~h!;evil=1~d!b~d', 'b')).toEqual({
			collapsed: undefined,
			done: true,
		})
		expect(writeRemembered('a~h', 'bad;id', { collapsed: true })).toBe('a~h')
	})
})
