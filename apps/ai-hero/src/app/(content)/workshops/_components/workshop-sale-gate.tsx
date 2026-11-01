'use client'

import type { ReactNode } from 'react'

import { useWorkshopAbility } from './use-workshop-ability'

/**
 * Sales copy on a workshop page is for people who can't open it. Waits for
 * the ability the page already loads, so an owner never sees it flash.
 */
export function WorkshopSaleGate({ children }: { children: ReactNode }) {
	const { canViewWorkshop, status } = useWorkshopAbility()
	return status === 'success' && !canViewWorkshop ? children : null
}
