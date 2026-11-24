import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

import { existingReadActions } from './server-action-export-allowlist'

const readName = /^(get|list|find|load)/

function bindingNames(name: ts.BindingName): string[] {
	return ts.isIdentifier(name)
		? [name.text]
		: name.elements.flatMap((element) =>
				ts.isBindingElement(element) ? bindingNames(element.name) : [],
			)
}

function readActionExports(path: string, source: string): string[] {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest)
	const [first] = file.statements
	if (
		!first ||
		!ts.isExpressionStatement(first) ||
		!ts.isStringLiteral(first.expression) ||
		first.expression.text !== 'use server'
	) {
		return []
	}

	return file.statements.flatMap((statement) => {
		if (ts.isExportDeclaration(statement)) {
			if (statement.isTypeOnly) return []
			const clause = statement.exportClause
			// Require explicit names rather than silently skipping a wildcard.
			if (!clause) return ['*']
			const names = ts.isNamespaceExport(clause)
				? [clause.name.text]
				: clause.elements
						.filter((item) => !item.isTypeOnly)
						.map((item) => item.name.text)
			return names.filter((name) => readName.test(name))
		}

		if (!ts.canHaveModifiers(statement)) return []
		const modifiers = ts.getModifiers(statement)
		if (
			!modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) ||
			modifiers.some(
				({ kind }) =>
					kind === ts.SyntaxKind.DefaultKeyword || kind === ts.SyntaxKind.DeclareKeyword,
			)
		) {
			return []
		}

		if (ts.isVariableStatement(statement)) {
			return statement.declarationList.declarations
				.flatMap((declaration) => bindingNames(declaration.name))
				.filter((name) => readName.test(name))
		}

		if (
			ts.isFunctionDeclaration(statement) ||
			ts.isClassDeclaration(statement) ||
			ts.isEnumDeclaration(statement) ||
			ts.isModuleDeclaration(statement)
		) {
			const name = statement.name?.text
			if (name && readName.test(name)) return [name]
		}
		return []
	})
}

it('detects read-shaped value exports only at a module-level server action boundary', () => {
	expect(
		readActionExports('fixture.ts', `
			// A comment before the directive is fine.
			"use server";
			export async function getRecord() {}
			export const update = async () => {}, loadRecord = async () => {};
			export { lookup as findRecord, getInternal as saveRecord } from './queries';
			export { type getType } from './types';
			export type listType = string;
			export default async function getDefault() {}
		`),
	).toEqual(['getRecord', 'loadRecord', 'findRecord'])
	expect(readActionExports('fixture.ts', `'use server'; export * from './queries'`)).toEqual(['*'])
	expect(
		readActionExports('fixture.ts', `import 'server-only'; export async function getRecord() { 'use server' }`),
	).toEqual([])
})

it('adds no read-shaped exports to use-server modules', () => {
	const root = fileURLToPath(new URL('../', import.meta.url))
	const paths = globSync('**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', { cwd: root })
	const found = new Set(
		paths.flatMap((path) =>
			readActionExports(path, readFileSync(join(root, path), 'utf8')).map(
				(name) => `${path}#${name}`,
			),
		),
	)
	const allowed = new Set(Object.keys(existingReadActions))

	expect(
		[...found].filter((entry) => !allowed.has(entry)).sort(),
		'Move reads into a server-only module. Name exports explicitly; do not add new reads to the allowlist.',
	).toEqual([])
	expect(
		[...allowed].filter((entry) => !found.has(entry)).sort(),
		'Remove stale entries from the server action allowlist.',
	).toEqual([])
})
