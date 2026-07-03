import * as React from 'react'
import { ResourceType as ResourceTypeFromTypes } from '@/lib/resource-types'
import { ResourceCreationConfig } from '@/lib/resources'
import { z } from 'zod'

import { ContentResource } from '@coursebuilder/core/schemas'

/**
 * Base fields required for all resource types in the system.
 * These fields are common across all resources and provide a consistent interface
 * for handling basic resource metadata.
 *
 * (Extracted from the retired `withResourceForm` HOC — kept as the shared shape
 * for per-type form configs such as `postFormConfig`.)
 */
export interface BaseResourceFields {
	body?: string | null
	title?: string | null
	slug: string
	visibility?: string
	state?: string
	description?: string | null
}

/**
 * Base configuration for resource tools
 */
export type BaseTool = {
	id: string
	label?: string
	icon?: () => React.ReactElement
	toolComponent?: React.ReactElement
}

/**
 * Configuration interface for resource form functionality.
 * Defines how a resource form behaves, including validation, updates,
 * and UI customization.
 *
 * @template T - Resource type extending ContentResource with BaseResourceFields
 * @template S - Zod schema for form validation
 */
export interface ResourceFormConfig<
	T extends ContentResource & {
		fields: BaseResourceFields
	},
	S extends z.ZodSchema,
> {
	/** Type of resource being edited */
	resourceType: ResourceTypeFromTypes

	/** Zod schema for form validation */
	schema: S

	/** Function to generate default form values */
	defaultValues: (resource?: T) => z.infer<S>

	/** Configuration for creating new resources within this resource */
	createResourceConfig?: ResourceCreationConfig

	/**
	 * Configuration for creating new posts within this resource
	 * @deprecated Use createResourceConfig instead for more flexibility with all resource types
	 */
	createPostConfig?: {
		title: string
		defaultResourceType: string
		availableResourceTypes: string[]
	}

	/** Additional tools to be displayed in the resource editor */
	customTools?: BaseTool[]

	/** Function to generate resource URL path */
	getResourcePath: (slug?: string) => string

	/**
	 * Function to update resource data
	 * @throws {Error} When resource data is invalid or update fails
	 */
	updateResource: (
		resource: Partial<T>,
		action?: 'save' | 'publish' | 'archive' | 'unpublish',
	) => Promise<T>

	/**
	 * Optional function for automatic resource updates
	 * Used for auto-saving or background updates
	 */
	autoUpdateResource?: (
		resource: Partial<T>,
		action?: 'save' | 'publish' | 'archive' | 'unpublish',
	) => Promise<T>

	/** Optional callback after successful save */
	onSave?: (resource: ContentResource, hasNewSlug: boolean) => Promise<void>

	/**
	 * Configuration for the body panel
	 * Controls list resources display and configuration
	 */
	bodyPanelConfig?: {
		showListResources?: boolean
		listEditorConfig?: {
			title?: React.ReactNode
			searchConfig?: React.ReactNode
			showTierSelector?: boolean
			visibleResourceTypes?: string[]
			onResourceAdd?: (resource: ContentResource) => Promise<void>
			onResourceRemove?: (resourceId: string) => Promise<void>
			onResourceReorder?: (
				resourceId: string,
				newPosition: number,
			) => Promise<void>
			onResourceUpdate?: (
				itemId: string,
				fields: Record<string, any>,
			) => void | Promise<void>
			onQuickEdit?: (itemId: string) => void | Promise<void>
		}
	}
}
