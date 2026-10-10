import { db } from '@/db'

import { c5DecisionStoreOn } from './purchase-decision-sql'

/** The C5 decision store on the app database. */
export const drizzleC5DecisionStore = () => c5DecisionStoreOn(db)
