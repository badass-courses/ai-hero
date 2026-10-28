-- Crash Course team credit: schema-only prerequisite, no runtime readers/writers.
-- Apply on a PlanetScale development branch through a reviewed deploy request.
-- Never apply DDL directly to production. The owner opens the deploy request.
-- Both creates are existence-guarded; rerunning preserves all existing rows.
-- No existing tables change. No foreign keys, triggers, or customer data.
--
-- One reservation per Stripe invoice, many source-purchase allocations.
-- reserved and paid consume credit; released is a retained terminal receipt.
-- Schema alone does NOT stop overspend: the follow-up writer must lock source
-- Purchase rows in sorted id order, use current locking consumption reads, and
-- atomically persist reservation + allocations. Every entry point (including
-- backfill/reconcile) must use that protocol. Never delete terminal receipts.
-- Deploy application readers/writers only AFTER both tables exist on main.

CREATE TABLE IF NOT EXISTS `AI_CcCreditReservation` (
  `invoiceId` varchar(191) NOT NULL,
  `stripeCustomerId` varchar(191) NOT NULL,
  `organizationId` varchar(191) NULL,
  `requestHash` varchar(64) NOT NULL,
  `seats` int unsigned NOT NULL,
  `amountCents` bigint unsigned NOT NULL,
  `currency` varchar(3) NOT NULL,
  `status` enum('reserved','paid','released') NOT NULL,
  `audit` json NOT NULL,
  `createdAt` timestamp(3) NOT NULL,
  `updatedAt` timestamp(3) NOT NULL,
  `paidAt` timestamp(3) NULL,
  `releasedAt` timestamp(3) NULL,
  PRIMARY KEY (`invoiceId`),
  KEY `CcCreditReservation_org_status_idx` (`organizationId`, `status`),
  KEY `CcCreditReservation_customer_status_idx` (`stripeCustomerId`, `status`),
  KEY `CcCreditReservation_status_updated_idx` (`status`, `updatedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `AI_CcCreditAllocation` (
  `invoiceId` varchar(191) NOT NULL,
  `purchaseId` varchar(191) NOT NULL,
  `seats` int unsigned NOT NULL,
  `perSeatCents` bigint unsigned NOT NULL,
  `purchaseSeats` int unsigned NOT NULL,
  `purchaseTotalCents` bigint unsigned NOT NULL,
  PRIMARY KEY (`invoiceId`, `purchaseId`),
  KEY `CcCreditAllocation_purchase_invoice_idx` (`purchaseId`, `invoiceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
