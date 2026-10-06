import { deniedDatabasePort, denyDatabaseOperation } from './db-guard-state'
export const db = deniedDatabasePort('db')
export const courseBuilderAdapter = deniedDatabasePort('courseBuilderAdapter')
export const createDatabaseHandle = () => denyDatabaseOperation('createDatabaseHandle')
export const acquireDatabaseConnection = () => denyDatabaseOperation('acquireDatabaseConnection')
export const closeDatabasePool = () => denyDatabaseOperation('closeDatabasePool')
