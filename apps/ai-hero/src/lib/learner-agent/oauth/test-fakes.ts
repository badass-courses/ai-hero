/**
 * In-memory stand-ins for the OAuth tests: a device token table that
 * evaluates the drizzle `eq` / `and` / `isNull` conditions the routes build,
 * and a Redis with SET NX/XX. Tests mock `drizzle-orm` with `drizzleFake`.
 */

type Row = Record<string, unknown>
type Condition =
	| { op: 'eq'; column: string; value: unknown }
	| { op: 'isNull'; column: string }
	| { op: 'and'; conditions: Condition[] }

export const drizzleFake = {
	eq: (column: string, value: unknown): Condition => ({
		op: 'eq',
		column,
		value,
	}),
	isNull: (column: string): Condition => ({ op: 'isNull', column }),
	and: (...conditions: Condition[]): Condition => ({
		op: 'and',
		conditions,
	}),
}

export const schemaFake = {
	deviceAccessToken: {
		token: 'token',
		userId: 'userId',
		scope: 'scope',
		revokedAt: 'revokedAt',
	},
	deviceVerifications: { deviceCode: 'deviceCode' },
}

function matches(row: Row, condition: Condition | undefined): boolean {
	if (!condition) return true
	switch (condition.op) {
		case 'eq':
			return row[condition.column] === condition.value
		case 'isNull':
			return (
				row[condition.column] === null || row[condition.column] === undefined
			)
		case 'and':
			return condition.conditions.every((entry) => matches(row, entry))
	}
}

export function makeTokenTable() {
	const rows: Row[] = []
	const db = {
		query: {
			deviceAccessToken: {
				findFirst: async ({ where }: { where?: Condition }) =>
					rows.find((row) => matches(row, where)) ?? undefined,
				findMany: async ({ where }: { where?: Condition }) =>
					rows.filter((row) => matches(row, where)),
			},
		},
		insert: () => ({
			values: async (values: Row) => {
				rows.push({ createdAt: new Date(), ...values })
			},
		}),
		update: () => ({
			set: (values: Row) => ({
				where: async (where: Condition) => {
					for (const row of rows)
						if (matches(row, where)) Object.assign(row, values)
				},
			}),
		}),
	}
	return { rows, db }
}

export function makeRedisFake() {
	const store = new Map<string, string>()
	return {
		store,
		redis: {
			set: async (
				key: string,
				value: string,
				options: { nx?: boolean; xx?: boolean } = {},
			) => {
				if (options.nx && store.has(key)) return null
				if (options.xx && !store.has(key)) return null
				store.set(key, value)
				return 'OK'
			},
			get: async (key: string) => store.get(key) ?? null,
		},
	}
}
