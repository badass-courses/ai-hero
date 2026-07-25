import { createProcessor } from '@mdx-js/mdx'
import {
	QuestionResourceSchema,
	type QuestionResource,
} from '@coursebuilder/survey/types'

import { CourseSyncError } from './errors'

type AstNode = {
	type?: string
	[key: string]: unknown
}

type MdxNode = {
	type?: string
	name?: string
	attributes?: unknown[]
	children?: unknown[]
}

export type ExtractedQuizQuestion = {
	id: string
	position: number
	fields: QuestionResource
}

function asNode(value: unknown): AstNode {
	if (!value || typeof value !== 'object') {
		throw new Error('expected a static expression')
	}
	return value as AstNode
}

function propertyName(node: AstNode): string {
	if (node.computed) throw new Error('computed property names are not supported')
	const key = asNode(node.key)
	if (key.type === 'Identifier' && typeof key.name === 'string') return key.name
	if (key.type === 'Literal' && typeof key.value === 'string') return key.value
	throw new Error('object property names must be static strings')
}

function staticValue(value: unknown): unknown {
	const node = asNode(value)
	switch (node.type) {
		case 'Literal':
			return node.value
		case 'ArrayExpression':
			return (node.elements as unknown[]).map((element) => {
				if (element === null) throw new Error('sparse arrays are not supported')
				return staticValue(element)
			})
		case 'ObjectExpression': {
			const result: Record<string, unknown> = {}
			for (const rawProperty of node.properties as unknown[]) {
				const property = asNode(rawProperty)
				if (property.type !== 'Property' || property.kind !== 'init') {
					throw new Error('object spreads and methods are not supported')
				}
				result[propertyName(property)] = staticValue(property.value)
			}
			return result
		}
		case 'UnaryExpression': {
			const argument = staticValue(node.argument)
			if (node.operator === '-' && typeof argument === 'number') return -argument
			if (node.operator === '+' && typeof argument === 'number') return argument
			throw new Error(`unsupported unary operator ${String(node.operator)}`)
		}
		default:
			throw new Error(`dynamic expression ${String(node.type)} is not supported`)
	}
}

function dataExpression(node: MdxNode): AstNode | null {
	const attribute = node.attributes?.find((candidate) => {
		const value = candidate as MdxNode
		return value.type === 'mdxJsxAttribute' && value.name === 'data'
	}) as (MdxNode & { value?: unknown }) | undefined
	if (!attribute?.value || typeof attribute.value !== 'object') return null
	const expression = attribute.value as {
		type?: string
		data?: { estree?: AstNode }
	}
	if (expression.type !== 'mdxJsxAttributeValueExpression') return null
	const program = expression.data?.estree
	const statement = Array.isArray(program?.body) ? program.body[0] : null
	const statementNode = statement ? asNode(statement) : null
	return statementNode?.type === 'ExpressionStatement'
		? asNode(statementNode.expression)
		: null
}

function questionError(
	lessonId: string,
	id: string,
	reason: string,
): CourseSyncError {
	return new CourseSyncError(
		'INVALID_QUIZ_QUESTION',
		`Lesson ${lessonId} has invalid QuizQuestion id ${id}: ${reason}`,
	)
}

export function extractQuizQuestions(
	body: string,
	lessonId: string,
): ExtractedQuizQuestion[] {
	let tree: MdxNode
	try {
		tree = createProcessor({ format: 'mdx' }).parse(body) as MdxNode
	} catch (error) {
		throw questionError(
			lessonId,
			'<unknown>',
			error instanceof Error ? `MDX parse failed: ${error.message}` : 'MDX parse failed',
		)
	}

	const questions: ExtractedQuizQuestion[] = []
	const visit = (node: MdxNode) => {
		if (
			(node.type === 'mdxJsxFlowElement' ||
				node.type === 'mdxJsxTextElement') &&
			node.name === 'QuizQuestion'
		) {
			const expression = dataExpression(node)
			if (!expression) {
				throw questionError(lessonId, '<missing>', 'data must be a static object literal')
			}
			let data: unknown
			try {
				data = staticValue(expression)
			} catch (error) {
				throw questionError(
					lessonId,
					'<unknown>',
					error instanceof Error ? error.message : 'data is not static',
				)
			}
			if (!data || typeof data !== 'object' || Array.isArray(data)) {
				throw questionError(lessonId, '<missing>', 'data must be an object')
			}
			const { id, ...fields } = data as Record<string, unknown>
			if (typeof id !== 'string' || !id.trim()) {
				throw questionError(lessonId, '<missing>', 'id is required')
			}
			const normalizedId = id.trim()
			if (questions.some((question) => question.id === normalizedId)) {
				throw questionError(lessonId, normalizedId, 'id is duplicated in this lesson')
			}
			const parsed = QuestionResourceSchema.safeParse(fields)
			if (!parsed.success) {
				throw questionError(lessonId, normalizedId, parsed.error.message)
			}
			questions.push({
				id: normalizedId,
				position: questions.length,
				fields: parsed.data,
			})
		}
		for (const child of node.children ?? []) visit(child as MdxNode)
	}
	visit(tree)
	return questions
}
