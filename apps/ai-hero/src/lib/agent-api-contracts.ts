import { z } from 'zod'

import { ContentResourceSchema } from '@coursebuilder/core/schemas/content-resource-schema'
import { productSchema, VideoChapterSchema } from '@coursebuilder/core/schemas'
import { VideoResourceSchema } from '@coursebuilder/core/schemas/video-resource'

import { LessonActionSchema, LessonSchema, LessonUpdateSchema } from './lessons'
import { PageSchema, UpdatePageSchema } from './pages'
import { MintPersonalAccessTokenSchema } from './personal-access-tokens'
import { NewPostInputSchema, PostSchema, PostUpdateSchema } from './posts'
import { ProductCreateApiSchema, ProductUpdateApiSchema } from './products'
import { SkillChangelogPostSchema } from './skill-changelog'
import {
	NewSolutionInputSchema,
	SolutionSchema,
	SolutionUpdateSchema,
} from './solution'
import {
	CreateShortlinkSchema,
	UpdateShortlinkSchema,
} from './shortlinks-types'
import { PostTagInputSchema, TagFieldsSchema, TagSchema } from './tags'
import { UploadBodySchema } from './upload-contracts'
import {
	CompleteMultipartUploadSchema,
	CreateMultipartUploadSchema,
} from '../video-uploader/multipart-contracts'

export const EmptyObjectResponseSchema = z.object({}).strict()

export const ErrorResponseSchema = z
	.object({
		error: z.union([
			z.string(),
			z.object({ message: z.string(), code: z.string() }),
			z.array(z.unknown()),
		]),
		details: z.unknown().optional(),
		issues: z.array(z.unknown()).optional(),
		fix: z.string().optional(),
		docs: z.string().optional(),
		next_actions: z.array(z.unknown()).optional(),
	})
	.passthrough()

export const NextActionSchema = z.object({
	command: z.string(),
	description: z.string(),
	params: z
		.record(
			z.object({
				description: z.string().optional(),
				value: z.union([z.string(), z.number()]).optional(),
				default: z.union([z.string(), z.number()]).optional(),
				enum: z.array(z.string()).optional(),
				required: z.boolean().optional(),
			}),
		)
		.optional(),
})

export const PostCreateRequestSchema = NewPostInputSchema.omit({
	createdById: true,
})
// The posts PUT handler reads `action` from the query string only and passes
// the body straight to updatePost, so the body schema must not offer an
// action field.
export const PostUpdateRequestSchema = PostUpdateSchema
export const PostResponseSchema = PostSchema
export const PostReadResponseSchema = z.union([PostSchema, z.array(PostSchema)])
export const DeleteMessageResponseSchema = z.object({ message: z.string() })

export const LessonUpdateRequestSchema = z.union([
	LessonUpdateSchema.extend({ action: LessonActionSchema.optional() }),
	z.object({ action: LessonActionSchema }),
])
export const LessonWithParentsSchema = LessonSchema.extend({
	parentResources: z.array(ContentResourceSchema).optional(),
})
export const LessonReadResponseSchema = z.union([
	LessonWithParentsSchema,
	z.array(LessonSchema),
])
export const LessonResponseSchema = LessonSchema

export const SolutionCreateRequestSchema = NewSolutionInputSchema.omit({
	createdById: true,
	parentLessonId: true,
})
export const SolutionUpdateRequestSchema = SolutionUpdateSchema.omit({
	id: true,
})
export const SolutionResponseSchema = SolutionSchema

export { ProductCreateApiSchema, ProductUpdateApiSchema }
export const ProductResponseSchema = productSchema
export const ProductReadResponseSchema = z.union([
	productSchema,
	z.array(productSchema),
])
export const ProductAvailabilityResponseSchema = z.object({
	quantityAvailable: z.number().int(),
	unlimited: z.boolean(),
})

export const ResourceReadResponseSchema = z.union([
	ContentResourceSchema,
	z.array(ContentResourceSchema),
])
export const ResourceCreateRequestSchema = z
	.object({
		type: z.string().min(1),
		title: z.string().trim().min(2),
		// slug is typed so a number/object/whitespace value cannot become the
		// persisted resource slug; other resource-specific fields pass through.
		fields: z
			.object({ slug: z.string().trim().min(1).optional() })
			.passthrough()
			.optional(),
	})
	.passthrough()
export const ResourceUpdateRequestSchema = z
	.object({
		fields: z
			// null clears chapters in the handler, so the contract must allow it
			.object({ chapters: z.array(VideoChapterSchema).nullable().optional() })
			.passthrough()
			.optional(),
	})
	.passthrough()
export const ResourceResponseSchema = ContentResourceSchema

export const SearchHitSchema = z.object({
	id: z.string(),
	type: z.string(),
	title: z.string(),
	slug: z.string(),
	url: z.string().url(),
	summary: z.string(),
	vector_distance: z.number().optional(),
	rank_fusion_score: z.number().optional(),
})
export const SearchResultSchema = z.object({
	query: z.string(),
	found: z.number(),
	search_time_ms: z.number(),
	mode: z.enum(['keyword', 'hybrid']),
	hits: z.array(SearchHitSchema),
})
export const SearchSuccessResponseSchema = z.object({
	ok: z.literal(true),
	command: z.string(),
	result: SearchResultSchema,
	next_actions: z.array(NextActionSchema),
})

export { SkillChangelogPostSchema }
export const SkillChangelogResultSchema = z.union([
	z.object({
		resource: ContentResourceSchema,
		url: z.string(),
		newsletterCopy: z.string(),
		requestId: z.string(),
		inngestEventId: z.string().nullable(),
	}),
	z.object({
		created: z.literal(true),
		parsed: z.literal(false),
		resourceId: z.string(),
		slug: z.string(),
		url: z.string(),
	}),
])
export const SkillChangelogSuccessResponseSchema = z.object({
	ok: z.literal(true),
	command: z.string(),
	result: SkillChangelogResultSchema,
	next_actions: z.array(NextActionSchema),
	/** @deprecated Read the canonical nested result instead. */
	id: z.string(),
	/** @deprecated Read the canonical nested result instead. */
	slug: z.string(),
})
export const CommandPreflightResultSchema = z.object({
	methods: z.array(z.string()),
})

export { CompleteMultipartUploadSchema, CreateMultipartUploadSchema }
export const CreateMultipartUploadResponseSchema = z.object({
	uploadId: z.string(),
	key: z.string(),
	publicUrl: z.string().url(),
})
export const CompleteMultipartUploadResponseSchema = z.object({
	publicUrl: z.string().url(),
	key: z.string(),
})
export const MultipartPartUrlResponseSchema = z.object({
	signedUrl: z.string().url(),
	partNumber: z.number().int().positive(),
})
export { UploadBodySchema }
export const UploadStartedResponseSchema = z.object({
	success: z.literal(true),
})
export const SignedUploadUrlResponseSchema = z.object({
	signedUrl: z.string().url(),
	filename: z.string(),
	objectName: z.string(),
	publicUrl: z.string().url(),
})
export const VideoResourceResponseSchema = VideoResourceSchema

export const ShortlinkSchema = z.object({
	id: z.string(),
	slug: z.string(),
	url: z.string().url(),
	description: z.string().nullable(),
	metadata: z.record(z.unknown()).nullable(),
	clicks: z.number().int(),
	createdById: z.string().nullable(),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
})
export const ScopedShortlinkSchema = ShortlinkSchema.omit({ clicks: true })
export const ShortlinkResponseSchema = z.union([
	ShortlinkSchema,
	ScopedShortlinkSchema,
])
export const ShortlinkReadResponseSchema = z.union([
	ShortlinkSchema,
	ScopedShortlinkSchema,
	z.array(ShortlinkSchema),
	z.array(ScopedShortlinkSchema),
])
export { CreateShortlinkSchema, UpdateShortlinkSchema }

export const CreateTagRequestSchema = z.object({
	id: z.string().optional(),
	type: z.literal('topic').optional(),
	fields: TagFieldsSchema,
	createdAt: z.union([z.string(), z.date()]).optional(),
	updatedAt: z.union([z.string(), z.date()]).optional(),
})
export const TagResponseSchema = TagSchema
export const TagListResponseSchema = z.array(TagSchema)
export { PostTagInputSchema }
export const PostTagMutationResponseSchema = z.object({
	success: z.literal(true),
	action: z.enum(['attach', 'remove']),
	postId: z.string(),
	tagId: z.string(),
})

export { UpdatePageSchema }
export const PageResponseSchema = PageSchema
export const PageReadResponseSchema = z.union([PageSchema, z.array(PageSchema)])

export { MintPersonalAccessTokenSchema }
export const PersonalAccessTokenResponseSchema = z.object({
	id: z.string(),
	name: z.string(),
	tokenPrefix: z.string(),
	scopes: z.array(z.string()),
	createdAt: z.coerce.date().nullable(),
	lastUsedAt: z.coerce.date().nullable(),
	expiresAt: z.coerce.date().nullable(),
	revokedAt: z.coerce.date().nullable(),
})
export const MintPersonalAccessTokenResponseSchema =
	PersonalAccessTokenResponseSchema.extend({
		token: z.string().startsWith('aih_pat_'),
	})
