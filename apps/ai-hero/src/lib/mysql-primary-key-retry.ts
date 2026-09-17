export const MYSQL_PRIMARY_KEY_RETRY_ATTEMPTS = 3

type ErrorLike = {
	cause?: unknown
	code?: unknown
	errno?: unknown
	message?: unknown
	sqlMessage?: unknown
}

function errorChain(error: unknown) {
	const chain: ErrorLike[] = []
	let current = error
	for (
		let depth = 0;
		depth < 5 && current && typeof current === 'object';
		depth++
	) {
		const candidate = current as ErrorLike
		chain.push(candidate)
		current = candidate.cause
	}
	return chain
}

export function isMysqlDuplicateEntryError(error: unknown) {
	const chain = errorChain(error)
	const messages = chain.map((candidate) =>
		[candidate.message, candidate.sqlMessage]
			.filter((value): value is string => typeof value === 'string')
			.join(' '),
	)
	return (
		chain.some(
			(candidate) =>
				candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062,
		) || messages.some((message) => /Duplicate entry/i.test(message))
	)
}

function isMysqlPrimaryKeyDuplicate(error: unknown) {
	const chain = errorChain(error)
	const messages = chain.map((candidate) =>
		[candidate.message, candidate.sqlMessage]
			.filter((value): value is string => typeof value === 'string')
			.join(' '),
	)
	if (!isMysqlDuplicateEntryError(error)) return false

	return messages.some((message) =>
		/for key\s+['"`]?(?:[^'"`\s]+\.)?PRIMARY['"`]?/i.test(message),
	)
}

/** Retries only random MySQL PRIMARY-key collisions. */
export async function withMysqlPrimaryKeyRetry<T>(
	operation: (attempt: number) => Promise<T>,
): Promise<T> {
	for (let attempt = 0; attempt < MYSQL_PRIMARY_KEY_RETRY_ATTEMPTS; attempt++) {
		try {
			return await operation(attempt)
		} catch (error) {
			const hasAttemptLeft = attempt + 1 < MYSQL_PRIMARY_KEY_RETRY_ATTEMPTS
			if (!hasAttemptLeft || !isMysqlPrimaryKeyDuplicate(error)) throw error
		}
	}

	throw new Error('Unreachable MySQL primary-key retry state')
}
