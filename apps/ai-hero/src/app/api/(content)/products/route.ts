import { NextRequest, NextResponse } from 'next/server'
import { courseBuilderAdapter } from '@/db'
import {
	getProductsWithFullStructure,
	getProductWithFullStructure,
} from '@/lib/products-query'
import { sanitizeResourcePayload } from '@/lib/resource-api-sanitizer'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { z } from 'zod'

import { NewProductSchema } from '@coursebuilder/core/schemas'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

/**
 * GET /api/products
 * Returns all products OR single product if ?slugOrId=xxx provided
 * Product includes full nested structure: product → cohort → workshops → sections → lessons
 */
const getProductsHandler = async (request: NextRequest) => {
	const { searchParams } = new URL(request.url)
	const slugOrId = searchParams.get('slugOrId')

	try {
		const { ability, user } = await getUserAbilityForRequest(request)
		await log.info('api.products.get.started', {
			userId: user?.id,
			slugOrId,
			hasAbility: !!ability,
		})

		if (ability.cannot('read', 'Content')) {
			await log.warn('api.products.get.unauthorized', {
				userId: user?.id,
				slugOrId,
			})
			return NextResponse.json(
				{ error: 'Unauthorized' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (slugOrId) {
			const product = await getProductWithFullStructure(slugOrId)

			if (!product) {
				await log.warn('api.products.get.notfound', {
					userId: user?.id,
					slugOrId,
				})
				return NextResponse.json(
					{ error: 'Product not found' },
					{ status: 404, headers: corsHeaders },
				)
			}

			await log.info('api.products.get.success', {
				userId: user?.id,
				slugOrId,
				productId: product.id,
			})

			return NextResponse.json(sanitizeResourcePayload(product), {
				headers: corsHeaders,
			})
		}

		const products = await getProductsWithFullStructure()

		await log.info('api.products.get.success', {
			userId: user?.id,
			resultCount: products.length,
		})

		return NextResponse.json(sanitizeResourcePayload(products), {
			headers: corsHeaders,
		})
	} catch (error) {
		await log.error('api.products.get.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
			slugOrId,
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}
export const GET = withSkill(getProductsHandler)

const ProductCreateApiSchema = NewProductSchema.extend({
	slug: z.string().min(2).max(191).optional(),
})

const ProductUpdateApiSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(2).max(90).optional(),
		price: z.coerce.number().gte(0).optional(),
		quantityAvailable: z.coerce.number().int().optional(),
		type: z
			.enum([
				'live',
				'self-paced',
				'membership',
				'cohort',
				'cohort-archive',
				'source-code-access',
			])
			.optional(),
		state: z.enum(['draft', 'published', 'archived', 'deleted']).optional(),
		visibility: z.enum(['public', 'private', 'unlisted']).optional(),
		slug: z.string().min(2).max(191).optional(),
		fields: z.record(z.any()).optional(),
	})
	.refine(
		(input) =>
			Boolean(
				input.name ||
				input.price !== undefined ||
				input.quantityAvailable !== undefined ||
				input.type ||
				input.state ||
				input.visibility ||
				input.slug ||
				input.fields,
			),
		{ message: 'Provide at least one product field to update' },
	)

const createProductHandler = async (request: NextRequest) => {
	try {
		const { ability, user } = await getUserAbilityForRequest(request)

		if (!user) {
			await log.warn('api.products.post.unauthorized')
			return NextResponse.json(
				{ error: 'Unauthorized' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (!ability.can('create', 'Content')) {
			await log.warn('api.products.post.forbidden', { userId: user.id })
			return NextResponse.json(
				{ error: 'Forbidden' },
				{ status: 403, headers: corsHeaders },
			)
		}

		const body = await request.json()
		const parsed = ProductCreateApiSchema.safeParse(body)

		if (!parsed.success) {
			return NextResponse.json(
				{ error: 'Invalid input', details: parsed.error.format() },
				{ status: 400, headers: corsHeaders },
			)
		}

		const { slug, ...productInput } = parsed.data

		await log.info('api.products.post.started', {
			userId: user.id,
			name: productInput.name,
			type: productInput.type,
			price: productInput.price,
			slug,
		})

		const createdProduct =
			await courseBuilderAdapter.createProduct(productInput)

		if (!createdProduct) {
			return NextResponse.json(
				{ error: 'Product not created' },
				{ status: 500, headers: corsHeaders },
			)
		}

		let product = await courseBuilderAdapter.getProduct(createdProduct.id)

		if (slug && product) {
			product = await courseBuilderAdapter.updateProduct({
				...product,
				fields: {
					...product.fields,
					slug,
				},
			})
		}

		const readback = await getProductWithFullStructure(createdProduct.id)

		await log.info('api.products.post.success', {
			userId: user.id,
			productId: createdProduct.id,
			slug: readback?.fields?.slug ?? product?.fields?.slug,
		})

		return NextResponse.json(readback ?? product ?? createdProduct, {
			status: 201,
			headers: corsHeaders,
		})
	} catch (error) {
		await log.error('api.products.post.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}
export const POST = withSkill(createProductHandler)

const updateProductHandler = async (request: NextRequest) => {
	try {
		const { ability, user } = await getUserAbilityForRequest(request)

		if (!user) {
			await log.warn('api.products.put.unauthorized')
			return NextResponse.json(
				{ error: 'Unauthorized' },
				{ status: 401, headers: corsHeaders },
			)
		}

		if (!ability.can('update', 'Content')) {
			await log.warn('api.products.put.forbidden', { userId: user.id })
			return NextResponse.json(
				{ error: 'Forbidden' },
				{ status: 403, headers: corsHeaders },
			)
		}

		const body = await request.json()
		const parsed = ProductUpdateApiSchema.safeParse(body)

		if (!parsed.success) {
			return NextResponse.json(
				{ error: 'Invalid input', details: parsed.error.format() },
				{ status: 400, headers: corsHeaders },
			)
		}

		const input = parsed.data
		const currentProduct = await courseBuilderAdapter.getProduct(input.id)

		if (!currentProduct) {
			return NextResponse.json(
				{ error: 'Product not found' },
				{ status: 404, headers: corsHeaders },
			)
		}

		if (input.price !== undefined && !currentProduct.price) {
			return NextResponse.json(
				{ error: 'Product has no price' },
				{ status: 400, headers: corsHeaders },
			)
		}

		const updatedProduct = await courseBuilderAdapter.updateProduct({
			...currentProduct,
			name: input.name ?? currentProduct.name,
			quantityAvailable:
				input.quantityAvailable ?? currentProduct.quantityAvailable,
			type: input.type ?? currentProduct.type,
			fields: {
				...currentProduct.fields,
				...(input.fields ?? {}),
				...(input.state && { state: input.state }),
				...(input.visibility && { visibility: input.visibility }),
				...(input.slug && { slug: input.slug }),
			},
			price:
				input.price !== undefined && currentProduct.price
					? {
							...currentProduct.price,
							unitAmount: input.price,
							nickname: input.name ?? currentProduct.price.nickname,
						}
					: currentProduct.price,
		})

		const readback = await getProductWithFullStructure(input.id)

		await log.info('api.products.put.success', {
			userId: user.id,
			productId: input.id,
			slug: readback?.fields?.slug ?? updatedProduct?.fields?.slug,
			price: readback?.price?.unitAmount ?? updatedProduct?.price?.unitAmount,
		})

		return NextResponse.json(readback ?? updatedProduct, {
			headers: corsHeaders,
		})
	} catch (error) {
		await log.error('api.products.put.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}
export const PUT = withSkill(updateProductHandler)
