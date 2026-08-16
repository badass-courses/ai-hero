import { CourseSyncError } from './errors'
import type { CourseSyncBinding } from './types'

export type TargetViolationCode =
	| 'TARGET_PRODUCT_NOT_FOUND'
	| 'TARGET_PRODUCT_TYPE_MISMATCH'
	| 'TARGET_PRODUCT_STATE_MISMATCH'
	| 'TARGET_PRODUCT_VISIBILITY_MISMATCH'
	| 'TARGET_WORKSHOP_NOT_FOUND'
	| 'TARGET_WORKSHOP_DELETED'
	| 'TARGET_WORKSHOP_TYPE_MISMATCH'
	| 'TARGET_WORKSHOP_STATE_MISMATCH'
	| 'TARGET_WORKSHOP_VISIBILITY_MISMATCH'
	| 'TARGET_RELATION_MISSING'
	| 'TARGET_RELATION_POSITION_MISMATCH'
	| 'TARGET_RELATION_SCOPE_WIDENED'
	| 'TARGET_CHILD_POSITION_INVALID'
	| 'TARGET_CHILD_TYPE_MISMATCH'
	| 'TARGET_CHILD_STATE_MISMATCH'
	| 'TARGET_CHILD_VISIBILITY_MISMATCH'
	| 'TARGET_CHILD_BINDING_MISMATCH'

export type TargetViolation = {
	code: TargetViolationCode
	target: Record<string, string | number>
	field:
		| 'exists'
		| 'deletedAt'
		| 'type'
		| 'state'
		| 'visibility'
		| 'position'
		| 'bindingId'
		| 'productScope'
	expected: string | number | boolean | null
	actual: string | number | boolean | null
}

export type CourseSyncTargetFacts = {
	product: {
		id: string
		type: string
		fields: unknown
	} | null
	workshop: {
		id: string
		type: string
		fields: unknown
		deletedAt: Date | null
	} | null
	relation: { position: number } | null
	otherProductRelations: Array<{ productId?: string }>
	childRelations: Array<{
		position: number
		resource?: { id?: string; type: string; fields: unknown } | null
	}>
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object'
		? (value as Record<string, unknown>)
		: {}
}

function scalar(value: unknown): string | number | boolean | null {
	return typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
		? value
		: null
}

function addMismatch(
	violations: TargetViolation[],
	input: Omit<TargetViolation, 'actual'> & { actual: unknown },
) {
	if (input.expected !== scalar(input.actual)) {
		violations.push({ ...input, actual: scalar(input.actual) })
	}
}

export function collectCourseSyncTargetViolations(
	binding: CourseSyncBinding,
	facts: CourseSyncTargetFacts,
): TargetViolation[] {
	const violations: TargetViolation[] = []
	const productTarget = { kind: 'product', id: binding.productId }
	const workshopTarget = { kind: 'workshop', id: binding.anchorWorkshopId }
	const relationTarget = {
		kind: 'relation',
		productId: binding.productId,
		workshopId: binding.anchorWorkshopId,
	}

	if (!facts.product) {
		violations.push({
			code: 'TARGET_PRODUCT_NOT_FOUND',
			target: productTarget,
			field: 'exists',
			expected: true,
			actual: false,
		})
	} else {
		const fields = record(facts.product.fields)
		addMismatch(violations, {
			code: 'TARGET_PRODUCT_TYPE_MISMATCH',
			target: productTarget,
			field: 'type',
			expected: binding.targetContract.product.type,
			actual: facts.product.type,
		})
		addMismatch(violations, {
			code: 'TARGET_PRODUCT_STATE_MISMATCH',
			target: productTarget,
			field: 'state',
			expected: binding.targetContract.product.state,
			actual: fields.state,
		})
		addMismatch(violations, {
			code: 'TARGET_PRODUCT_VISIBILITY_MISMATCH',
			target: productTarget,
			field: 'visibility',
			expected: binding.targetContract.product.visibility,
			actual: fields.visibility,
		})
	}

	if (!facts.workshop) {
		violations.push({
			code: 'TARGET_WORKSHOP_NOT_FOUND',
			target: workshopTarget,
			field: 'exists',
			expected: true,
			actual: false,
		})
	} else {
		const fields = record(facts.workshop.fields)
		if (facts.workshop.deletedAt !== null) {
			violations.push({
				code: 'TARGET_WORKSHOP_DELETED',
				target: workshopTarget,
				field: 'deletedAt',
				expected: null,
				actual: 'deleted',
			})
		}
		addMismatch(violations, {
			code: 'TARGET_WORKSHOP_TYPE_MISMATCH',
			target: workshopTarget,
			field: 'type',
			expected: binding.targetContract.workshop.type,
			actual: facts.workshop.type,
		})
		addMismatch(violations, {
			code: 'TARGET_WORKSHOP_STATE_MISMATCH',
			target: workshopTarget,
			field: 'state',
			expected: binding.targetContract.workshop.state,
			actual: fields.state,
		})
		addMismatch(violations, {
			code: 'TARGET_WORKSHOP_VISIBILITY_MISMATCH',
			target: workshopTarget,
			field: 'visibility',
			expected: binding.targetContract.workshop.visibility,
			actual: fields.visibility,
		})
	}

	if (!facts.relation) {
		violations.push({
			code: 'TARGET_RELATION_MISSING',
			target: relationTarget,
			field: 'exists',
			expected: true,
			actual: false,
		})
	} else {
		addMismatch(violations, {
			code: 'TARGET_RELATION_POSITION_MISMATCH',
			target: relationTarget,
			field: 'position',
			expected: binding.targetContract.relation.position,
			actual: facts.relation.position,
		})
	}
	if (facts.otherProductRelations.length > 0) {
		violations.push({
			code: 'TARGET_RELATION_SCOPE_WIDENED',
			target: relationTarget,
			field: 'productScope',
			expected: 1,
			actual: facts.otherProductRelations.length + 1,
		})
	}

	const positions = facts.childRelations.map((child) => child.position)
	for (const child of facts.childRelations) {
		const target = {
			kind: 'child',
			workshopId: binding.anchorWorkshopId,
			resourceId: child.resource?.id ?? 'missing',
			position: child.position,
		}
		if (
			!Number.isInteger(child.position) ||
			child.position < 0 ||
			positions.filter((position) => position === child.position).length !== 1
		) {
			violations.push({
				code: 'TARGET_CHILD_POSITION_INVALID',
				target,
				field: 'position',
				expected: 'unique non-negative integer',
				actual: child.position,
			})
		}
		const fields = record(child.resource?.fields)
		const courseSync = record(fields.courseSync)
		addMismatch(violations, {
			code: 'TARGET_CHILD_TYPE_MISMATCH',
			target,
			field: 'type',
			expected: 'section',
			actual: child.resource?.type,
		})
		addMismatch(violations, {
			code: 'TARGET_CHILD_STATE_MISMATCH',
			target,
			field: 'state',
			expected: binding.managedChildContract.state,
			actual: fields.state,
		})
		addMismatch(violations, {
			code: 'TARGET_CHILD_VISIBILITY_MISMATCH',
			target,
			field: 'visibility',
			expected: binding.managedChildContract.visibility,
			actual: fields.visibility,
		})
		addMismatch(violations, {
			code: 'TARGET_CHILD_BINDING_MISMATCH',
			target,
			field: 'bindingId',
			expected: binding.bindingId,
			actual: courseSync.bindingId,
		})
	}
	return violations
}

function violationText(violation: TargetViolation) {
	const targetId =
		violation.target.id ??
		violation.target.resourceId ??
		violation.target.workshopId ??
		'unknown'
	return `${String(violation.target.kind)} ${String(targetId)} ${violation.field} expected ${String(violation.expected)}, actual ${String(violation.actual)}`
}

export function assertCourseSyncTargetContract(
	binding: CourseSyncBinding,
	facts: CourseSyncTargetFacts,
) {
	const violations = collectCourseSyncTargetViolations(binding, facts)
	if (violations.length === 0) return
	throw new CourseSyncError(
		'TARGET_CONTRACT_MISMATCH',
		`Target contract mismatch: ${violations.map(violationText).join('; ')}.`,
		409,
		{
			category: 'target_precondition',
			retryable: false,
			details: {
				violations,
				expected: binding.targetContract,
				managedChildrenExpected: binding.managedChildContract,
			},
		},
	)
}
