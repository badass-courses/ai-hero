-- Apply through a reviewed safe-migration deploy request, never app startup.
-- MODIFY is repeatable. CREATE statements preserve existing tables.
ALTER TABLE `AI_PurchaseDecision` MODIFY COLUMN `codeRef` varchar(500) DEFAULT NULL;
CREATE TABLE IF NOT EXISTS `AI_GiftCodeSlot` (
  `codeRef` varchar(500) NOT NULL,
  `slot` int NOT NULL,
  `claimId` varchar(191) NOT NULL,
  `checkoutSessionId` varchar(191) DEFAULT NULL,
  `state` varchar(16) NOT NULL,
  `expiresAt` timestamp(3) NOT NULL,
  PRIMARY KEY (`codeRef`, `slot`),
  UNIQUE KEY `GiftCodeSlot_claim_idx` (`claimId`),
  UNIQUE KEY `GiftCodeSlot_session_idx` (`checkoutSessionId`)
);
CREATE TABLE IF NOT EXISTS `AI_GiftShareLink` (
  `slug` varchar(50) NOT NULL,
  `codeRef` varchar(500) NOT NULL,
  `firstName` varchar(100) NOT NULL,
  `legendId` varchar(191) NOT NULL,
  PRIMARY KEY (`slug`)
);
