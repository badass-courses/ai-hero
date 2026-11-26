import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it } from 'vitest'

// Inspect the actual registry without starting every provider imported by it.
it('registers countPaidCouponUse in the served Inngest function list', () => {
	const source = ts.createSourceFile(
		'inngest.config.ts',
		readFileSync(new URL('./inngest.config.ts', import.meta.url), 'utf8'),
		ts.ScriptTarget.Latest,
		true,
	)
	const variables = source.statements
		.filter(ts.isVariableStatement)
		.flatMap((statement) => [...statement.declarationList.declarations])
	const functions = variables.find(
		(declaration) => declaration.name.getText(source) === 'allFunctions',
	)?.initializer
	if (!functions || !ts.isArrayLiteralExpression(functions))
		throw new Error('Expected allFunctions array')
	expect(
		functions.elements.filter(
			(element) => element.getText(source) === 'countPaidCouponUse',
		),
	).toHaveLength(1)
	const config = variables.find(
		(declaration) => declaration.name.getText(source) === 'inngestConfig',
	)?.initializer
	if (!config || !ts.isObjectLiteralExpression(config))
		throw new Error('Expected Inngest config object')
	const served = config.properties
		.filter(ts.isPropertyAssignment)
		.find(
			(property) => property.name.getText(source) === 'functions',
		)?.initializer
	expect(
		served &&
			ts.isConditionalExpression(served) &&
			served.whenFalse.getText(source),
	).toBe('allFunctions')
})
