/**
 * CMS MDX may carry data, never code.
 *
 * MDX expressions compile to JavaScript that runs on the server during a
 * public render. `blockDangerousJS` is a denylist; the security desk reached
 * `process.env` past it (sec-036, 2026-11-21). `blockJS` would strip every
 * expression, but authored content relies on data in them: quiz `data={...}`
 * (160 uses), image sizes and URL maps, icon and fallback JSX, booleans, and
 * the `{percentOff}` style values a page passes in its scope.
 *
 * This remark plugin keeps an expression only when its syntax tree is pure
 * data: literals, arrays, plain objects, comments, JSX built from those, and
 * bare names the caller put in `scope`. Everything else (calls, member access,
 * operators, functions, spreads, other names) is removed before compile.
 */

type Estree = { type: string; [key: string]: unknown }
type MdxNode = {
	type: string
	children?: MdxNode[]
	value?: unknown
	data?: { estree?: Estree }
	attributes?: MdxAttribute[]
}
type MdxAttribute = {
	type: string
	name?: string
	value?: null | string | { type: string; data?: { estree?: Estree } }
}

export type StaticExpressionOptions = {
	/** Bare identifiers allowed, normally the keys of the compile `scope`. */
	allowedIdentifiers?: readonly string[]
	/** Called once per removed expression, for logging. */
	onRemoved?: (where: string) => void
}

function isStatic(node: unknown, allowed: ReadonlySet<string>): boolean {
	if (!node || typeof node !== 'object') return false
	const n = node as Estree
	switch (n.type) {
		case 'Literal':
			// A regex literal compiles to an object; refuse it.
			return !('regex' in n && n.regex)
		case 'TemplateLiteral':
			return Array.isArray(n.expressions) && n.expressions.length === 0
		case 'Identifier':
			return (
				typeof n.name === 'string' &&
				(n.name === 'undefined' || allowed.has(n.name))
			)
		case 'UnaryExpression':
			return (
				(n.operator === '-' || n.operator === '+') &&
				isNumericConstant(n.argument)
			)
		case 'BinaryExpression':
			// Authored image sizes like `width={737/1.2}`: constant math only.
			return isNumericConstant(n)
		case 'ArrayExpression':
			return (n.elements as unknown[]).every(
				(el) => el === null || isStatic(el, allowed),
			)
		case 'ObjectExpression':
			return (n.properties as Estree[]).every(
				(p) =>
					p.type === 'Property' &&
					p.kind === 'init' &&
					!p.method &&
					!p.computed &&
					((p.key as Estree).type === 'Identifier' ||
						(p.key as Estree).type === 'Literal') &&
					isStatic(p.value, allowed),
			)
		case 'JSXElement':
		case 'JSXFragment': {
			const opening = n.openingElement as Estree | undefined
			if (opening) {
				if (!isStaticJsxName(opening.name as Estree)) return false
				for (const attr of opening.attributes as Estree[]) {
					if (attr.type !== 'JSXAttribute') return false
					const v = attr.value as Estree | null
					if (v === null || v.type === 'Literal') continue
					if (v.type === 'JSXExpressionContainer') {
						if (!isStatic(v.expression, allowed)) return false
						continue
					}
					if (!isStatic(v, allowed)) return false
				}
			}
			return (n.children as Estree[]).every((child) => {
				if (child.type === 'JSXText') return true
				if (child.type === 'JSXExpressionContainer') {
					const e = child.expression as Estree
					return e.type === 'JSXEmptyExpression' || isStatic(e, allowed)
				}
				return isStatic(child, allowed)
			})
		}
		default:
			return false
	}
}

const ARITHMETIC = new Set(['+', '-', '*', '/', '%'])

/** A number literal, or arithmetic over number literals only. */
function isNumericConstant(node: unknown): boolean {
	if (!node || typeof node !== 'object') return false
	const n = node as Estree
	if (n.type === 'Literal') return typeof n.value === 'number'
	if (n.type === 'UnaryExpression') {
		return (
			(n.operator === '-' || n.operator === '+') &&
			isNumericConstant(n.argument)
		)
	}
	if (n.type === 'BinaryExpression') {
		return (
			ARITHMETIC.has(n.operator as string) &&
			isNumericConstant(n.left) &&
			isNumericConstant(n.right)
		)
	}
	return false
}

function isStaticJsxName(name: Estree): boolean {
	if (name.type === 'JSXIdentifier') return true
	if (name.type === 'JSXMemberExpression') {
		return (
			isStaticJsxName(name.object as Estree) &&
			(name.property as Estree).type === 'JSXIdentifier'
		)
	}
	return false
}

/** True when a whole MDX expression program is data only. */
export function isStaticProgram(
	program: Estree | undefined,
	allowed: ReadonlySet<string>,
): boolean {
	if (!program || program.type !== 'Program') return false
	const body = program.body as Estree[]
	// `{/* comment */}` parses to an empty body.
	if (body.length === 0) return true
	if (body.length !== 1 || body[0]!.type !== 'ExpressionStatement') return false
	return isStatic(body[0]!.expression, allowed)
}

export function remarkStaticMdxExpressions(
	options: StaticExpressionOptions = {},
) {
	const allowed = new Set(options.allowedIdentifiers ?? [])
	const keep = (n: MdxNode): boolean => {
		if (n.type === 'mdxjsEsm') {
			// import/export never belongs in CMS content.
			options.onRemoved?.('esm')
			return false
		}
		if (
			(n.type === 'mdxFlowExpression' || n.type === 'mdxTextExpression') &&
			!isStaticProgram(n.data?.estree, allowed)
		) {
			options.onRemoved?.(n.type)
			return false
		}
		return true
	}
	const walk = (n: MdxNode): void => {
		if (
			(n.type === 'mdxJsxFlowElement' || n.type === 'mdxJsxTextElement') &&
			n.attributes
		) {
			n.attributes = n.attributes.filter((attr) => {
				if (attr.type === 'mdxJsxExpressionAttribute') {
					options.onRemoved?.('spread attribute')
					return false
				}
				const v = attr.value
				if (v && typeof v === 'object') {
					const ok = isStaticProgram(v.data?.estree, allowed)
					if (!ok) options.onRemoved?.(`attribute ${attr.name ?? ''}`)
					return ok
				}
				return true
			})
		}
		if (!n.children) return
		n.children = n.children.filter(keep)
		for (const child of n.children) walk(child)
	}
	return (tree: unknown) => walk(tree as MdxNode)
}
