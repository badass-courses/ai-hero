-- Additive migration. Apply through a PlanetScale safe-migration deploy request
-- before deploying code that reads this table. No synthetic decision backfill.
CREATE TABLE IF NOT EXISTS `AI_PurchaseDecision` (
  `purchaseId` varchar(191) NOT NULL,
  `productId` varchar(191) NOT NULL,
  `decisionRef` varchar(500) NOT NULL,
  `creditSource` varchar(191) DEFAULT NULL,
  `codeRef` varchar(191) DEFAULT NULL,
  `basis` varchar(191) DEFAULT NULL,
  `restriction` varchar(16) NOT NULL,
  `amountCents` int DEFAULT NULL,
  `contract` varchar(191) NOT NULL,
  `engineVersion` varchar(191) NOT NULL,
  `policyVersion` varchar(191) NOT NULL,
  `checkoutSessionId` varchar(191) NOT NULL,
  `createdAt` timestamp(3) NOT NULL,
  PRIMARY KEY (`purchaseId`),
  KEY `PurchaseDecision_creditSource_idx` (`creditSource`, `productId`),
  KEY `PurchaseDecision_codeRef_idx` (`codeRef`)
);
