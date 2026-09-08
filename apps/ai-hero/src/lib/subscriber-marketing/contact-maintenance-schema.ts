import { CONTACT_EMAIL_STALE_SQL } from './contact-email-key-contract'

/** Restricted expression parser, not a SQL executor. Compare structure rather
 * than stripping parentheses (which would erase precedence). MySQL metadata
 * adds quoting, grouping and charset introducers and expands unary BINARY. */
export function integrityExpressionAst(source: string): unknown {
	const tokens: string[] = []
	const pattern =
		/\s+|`(?:``|[^`])*`|\\'[^'\\]*\\'|'(?:''|[^'])*'|<>|!=|[(),]|[a-zA-Z_][a-zA-Z_0-9]*|\d+/gy
	let at = 0
	while (at < source.length) {
		pattern.lastIndex = at
		const m = pattern.exec(source)
		if (!m) throw new Error('Unsupported expression')
		at = pattern.lastIndex
		if (!/^\s+$/.test(m[0])) tokens.push(m[0] === '!=' ? '<>' : m[0])
	}
	let i = 0
	const peek = () => tokens[i]?.toLowerCase()
	const take = () => {
		const t = tokens[i++]
		if (t === undefined) throw new Error('Incomplete expression')
		return t
	}
	const requireToken = (token: string) => {
		if (take().toLowerCase() !== token)
			throw new Error('Unexpected expression token')
	}
	function atom(): unknown {
		const t = take(),
			lower = t.toLowerCase()
		if (t === '(') {
			const e = expression()
			requireToken(')')
			return e
		}
		if (lower === 'binary') return ['cast', atom(), 'binary']
		if (lower === 'case') {
			const branches: unknown[] = []
			while (peek() === 'when') {
				take()
				const condition = expression()
				requireToken('then')
				branches.push([condition, expression()])
			}
			requireToken('else')
			const otherwise = expression()
			requireToken('end')
			return ['case', branches, otherwise]
		}
		if (lower === 'cast') {
			requireToken('(')
			const e = expression()
			requireToken('as')
			if (peek() === 'char') {
				take()
				requireToken('charset')
			}
			requireToken('binary')
			requireToken(')')
			return ['cast', e, 'binary']
		}
		if (lower === '_utf8mb4' || lower === '_ascii' || lower === '_binary') {
			if (!tokens[i]?.startsWith("'") && !tokens[i]?.startsWith("\\'"))
				throw new Error('Invalid charset literal')
			return atom()
		}
		if (t.startsWith("\\'")) return ['literal', t.slice(2, -2)]
		if (t.startsWith("'"))
			return ['literal', t.slice(1, -1).replaceAll("''", "'")]
		if (/^\d+$/.test(t)) return ['number', Number(t)]
		const rawName = lower.replace(/^`|`$/g, '')
		const name =
			rawName === 'length'
				? 'octet_length'
				: rawName === 'substr'
					? 'substring'
					: rawName
		if (peek() === '(') {
			if (
				!['left', 'octet_length', 'replace', 'substring', 'sha2'].includes(name)
			)
				throw new Error('Unsupported function')
			take()
			const args: unknown[] = [expression()]
			while (peek() === ',') {
				take()
				args.push(expression())
			}
			requireToken(')')
			return [name, ...args]
		}
		if (!['email', 'emailkey', 'emailkeysource'].includes(name))
			throw new Error('Unexpected column')
		return ['column', name]
	}
	function comparison(): unknown {
		let left = atom()
		if (peek() === 'is') {
			take()
			requireToken('null')
			left = ['is-null', left]
		} else if (peek() === '<>') {
			take()
			left = ['<>', left, atom()]
		}
		return left
	}
	function conjunction(): unknown {
		let left = comparison()
		while (peek() === 'and') {
			take()
			left = ['and', left, comparison()]
		}
		return left
	}
	function expression(): unknown {
		let left = conjunction()
		while (peek() === 'or') {
			take()
			left = ['or', left, conjunction()]
		}
		return left
	}
	const result = expression()
	if (i !== tokens.length) throw new Error('Trailing expression')
	return result
}
export type MetadataRow = Record<string, unknown>
export function schemaReady(
	columns: MetadataRow[],
	indexes: MetadataRow[],
	tables: MetadataRow[],
): boolean {
	try {
		if (tables.length !== 1 || tables[0]!.ENGINE !== 'InnoDB') return false
		const column = (name: string) => columns.find((c) => c.COLUMN_NAME === name)
		const raw = column('email'),
			key = column('emailKey'),
			source = column('emailKeySource'),
			stale = column('emailKeyStale'),
			id = column('id')
		if (!raw || !key || !source || !stale || !id) return false
		if (
			raw.DATA_TYPE !== 'varchar' ||
			Number(raw.CHARACTER_MAXIMUM_LENGTH) !== 255 ||
			raw.CHARACTER_SET_NAME !== 'utf8mb4' ||
			raw.IS_NULLABLE !== 'YES'
		)
			return false
		if (
			id.DATA_TYPE !== 'varchar' ||
			Number(id.CHARACTER_MAXIMUM_LENGTH) !== 255 ||
			id.IS_NULLABLE !== 'NO'
		)
			return false
		for (const [c, width] of [
			[key, 67],
			[source, 64],
		] as const)
			if (
				c.DATA_TYPE !== 'varchar' ||
				Number(c.CHARACTER_MAXIMUM_LENGTH) !== width ||
				c.CHARACTER_SET_NAME !== 'ascii' ||
				c.COLLATION_NAME !== 'ascii_bin' ||
				c.IS_NULLABLE !== 'YES' ||
				c.EXTRA !== ''
			)
				return false
		if (
			stale.DATA_TYPE !== 'int' ||
			stale.EXTRA !== 'STORED GENERATED' ||
			typeof stale.GENERATION_EXPRESSION !== 'string'
		)
			return false
		if (
			JSON.stringify(integrityExpressionAst(stale.GENERATION_EXPRESSION)) !==
			JSON.stringify(integrityExpressionAst(CONTACT_EMAIL_STALE_SQL))
		)
			return false
		for (const [name, col, nonunique] of [
			['PRIMARY', 'id', 0],
			['Contact_emailKey_idx', 'emailKey', 1],
			['Contact_emailKeyStale_idx', 'emailKeyStale', 1],
		] as const) {
			const parts = indexes.filter((x) => x.INDEX_NAME === name)
			if (
				parts.length !== 1 ||
				parts[0]!.COLUMN_NAME !== col ||
				Number(parts[0]!.NON_UNIQUE) !== nonunique ||
				parts[0]!.SUB_PART !== null ||
				parts[0]!.IS_VISIBLE !== 'YES' ||
				parts[0]!.INDEX_TYPE !== 'BTREE'
			)
				return false
		}
		// A second unique key involving the projections would destroy duplicate preservation.
		if (
			indexes.some(
				(x) =>
					Number(x.NON_UNIQUE) === 0 &&
					['emailKey', 'emailKeySource', 'emailKeyStale'].includes(
						String(x.COLUMN_NAME),
					),
			)
		)
			return false
		return true
	} catch {
		return false
	}
}
