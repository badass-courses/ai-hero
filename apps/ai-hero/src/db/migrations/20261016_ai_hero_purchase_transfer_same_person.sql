CREATE TABLE `AI_PurchaseTransferSamePerson` (
  `transferId` varchar(191) NOT NULL,
  `verifiedBy` varchar(64) NOT NULL,
  `reason` text NOT NULL,
  `proofRef` varchar(255) NOT NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`transferId`)
);
