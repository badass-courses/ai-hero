import { describe, expect, it, vi } from 'vitest'

import {
	isMysqlDuplicateEntryError,
	MYSQL_PRIMARY_KEY_RETRY_ATTEMPTS,
	withMysqlPrimaryKeyRetry,
} from './mysql-primary-key-retry'

function duplicateError(key: string) {
	return Object.assign(new Error(`Duplicate entry 'abc12' for key '${key}'`), {
		code: 'ER_DUP_ENTRY',
		errno: 1062,
	})
}

describe('isMysqlDuplicateEntryError', () => {
	it.each([
		"Duplicate entry '2' for key 'PRIMARY'",
		"Duplicate entry 'journey:2' for key 'EvergreenOfferJourneyCommit.PRIMARY'",
		"Duplicate entry 'intent-1' for key 'EvergreenOfferJourneyIntent.PRIMARY'",
	])('recognizes message-only duplicate errors: %s', (message) => {
		expect(isMysqlDuplicateEntryError(new Error(message))).toBe(true)
	})

	it('recognizes a nested PlanetScale semantic-key duplicate', () => {
		expect(
			isMysqlDuplicateEntryError({
				cause: new Error(
					"Duplicate entry 'wake-1' for key 'EvergreenOfferJourneyWake.PRIMARY'",
				),
			}),
		).toBe(true)
	})
})

describe('withMysqlPrimaryKeyRetry', () => {
	it('retries two primary-key collisions then succeeds', async () => {
		const operation = vi
			.fn(async (_attempt: number) => 'saved')
			.mockRejectedValueOnce(duplicateError('PRIMARY'))
			.mockRejectedValueOnce(duplicateError('PRIMARY'))

		await expect(withMysqlPrimaryKeyRetry(operation)).resolves.toBe('saved')
		expect(operation).toHaveBeenCalledTimes(3)
	})

	it('stops after the explicit attempt bound', async () => {
		const error = duplicateError('PRIMARY')
		const operation = vi.fn(async (_attempt: number): Promise<never> => {
			throw error
		})

		await expect(withMysqlPrimaryKeyRetry(operation)).rejects.toBe(error)
		expect(operation).toHaveBeenCalledTimes(MYSQL_PRIMARY_KEY_RETRY_ATTEMPTS)
	})

	it('handles the PlanetScale message shape without MySQL errno fields', async () => {
		const primaryError = new Error(
			"Duplicate entry 'abc12' for key 'AI_QuestionResponse.PRIMARY'",
		)
		const operation = vi
			.fn(async (_attempt: number) => 'saved')
			.mockRejectedValueOnce(primaryError)

		await expect(withMysqlPrimaryKeyRetry(operation)).resolves.toBe('saved')
		expect(operation).toHaveBeenCalledTimes(2)
	})

	it('does not retry semantic unique-key conflicts', async () => {
		const error = duplicateError('SideEffectIntent_idempotencyKey_uq')
		const operation = vi.fn(async (_attempt: number): Promise<never> => {
			throw error
		})

		await expect(withMysqlPrimaryKeyRetry(operation)).rejects.toBe(error)
		expect(operation).toHaveBeenCalledTimes(1)
	})
})
