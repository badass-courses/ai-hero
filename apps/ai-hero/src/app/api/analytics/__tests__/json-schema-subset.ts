export type Schema = {
	type?: string | string[]
	const?: unknown
	enum?: readonly unknown[]
	required?: readonly string[]
	properties?: Record<string, Schema>
	additionalProperties?: boolean
	items?: Schema
	oneOf?: readonly Schema[]
}

/** The subset of JSON Schema the published contract uses, checked strictly. */
export function violations(
	schema: Schema,
	value: unknown,
	path = '$',
): string[] {
	if (schema.oneOf) {
		const matches = schema.oneOf.filter(
			(option) => violations(option, value, path).length === 0,
		)
		return matches.length === 1
			? []
			: [`${path}: matches ${matches.length} oneOf`]
	}
	if ('const' in schema)
		return value === schema.const ? [] : [`${path}: expected ${schema.const}`]
	if (schema.enum)
		return schema.enum.includes(value) ? [] : [`${path}: not in enum`]
	const types = [schema.type].flat().filter(Boolean) as string[]
	const typeOf =
		value === null
			? 'null'
			: Array.isArray(value)
				? 'array'
				: Number.isInteger(value)
					? 'integer'
					: typeof value
	if (
		types.length &&
		!types.includes(typeOf) &&
		!(typeOf === 'integer' && types.includes('number'))
	)
		return [`${path}: ${typeOf} is not ${types.join('|')}`]
	if (typeOf === 'array' && schema.items)
		return (value as unknown[]).flatMap((item, index) =>
			violations(schema.items!, item, `${path}[${index}]`),
		)
	if (typeOf !== 'object') return []
	const record = value as Record<string, unknown>
	const problems = (schema.required ?? [])
		.filter((key) => !(key in record))
		.map((key) => `${path}.${key}: missing`)
	for (const [key, item] of Object.entries(record)) {
		const property = schema.properties?.[key]
		if (property) problems.push(...violations(property, item, `${path}.${key}`))
		else if (schema.additionalProperties === false)
			problems.push(`${path}.${key}: not in schema`)
	}
	return problems
}
