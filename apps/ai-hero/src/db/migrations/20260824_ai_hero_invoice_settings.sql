-- AIH-259: server-persisted invoice details (company/name/address/tax/notes)
-- plus redacted support prefill audit receipts.
-- Replaces browser-localStorage invoice fields. One settings row per
-- purchase + merchant charge.
--
-- ORDERING: apply this migration to production BEFORE deploying the code
-- that reads these tables. The invoice page reads AI_InvoiceSettings
-- unconditionally and fails closed (throws) if the table is missing.
CREATE TABLE `AI_InvoiceSettings` (
  `purchaseId` varchar(255) NOT NULL,
  `merchantChargeId` varchar(255) NOT NULL,
  `recipientName` varchar(255) NULL,
  `companyName` varchar(255) NULL,
  `address` text NULL,
  `taxId` varchar(100) NULL,
  `notes` text NULL,
  `source` varchar(20) NOT NULL DEFAULT 'owner',
  `updatedByUserId` varchar(255) NULL,
  `supportOperatorId` varchar(255) NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`purchaseId`, `merchantChargeId`)
);

-- Audit receipts for support invoice prefill attempts. Identifiers and
-- outcomes only; never raw billing values.
--
-- `requestKey` is set only on `prefilled` receipts. Its UNIQUE index is the
-- atomic replay guard: an exact replay of an applied signed request cannot
-- claim a second success receipt, so it cannot write settings. NULLs are
-- ignored by MySQL unique indexes, so other outcomes stay retryable.
CREATE TABLE `AI_SupportInvoicePrefillReceipt` (
  `id` varchar(191) NOT NULL,
  `purchaseId` varchar(255) NOT NULL,
  `merchantChargeId` varchar(255) NOT NULL,
  `runId` varchar(255) NOT NULL,
  `conversationId` varchar(255) NOT NULL,
  `operatorId` varchar(255) NOT NULL,
  `approvalReference` varchar(255) NOT NULL,
  `expectedInboundId` varchar(255) NOT NULL,
  `inputHash` varchar(64) NOT NULL,
  `requestKey` varchar(64) NULL,
  `outcome` varchar(40) NOT NULL,
  `readbackMatched` boolean NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `sipr_purchase_idx` (`purchaseId`),
  UNIQUE INDEX `sipr_request_key_uidx` (`requestKey`)
);
