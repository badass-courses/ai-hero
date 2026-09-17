CREATE TABLE `AI_PurchaseTransferOutbox` (
  `id` varchar(191) NOT NULL,
  `purchaseUserTransferId` varchar(191) NOT NULL,
  `purchaseId` varchar(191) NOT NULL,
  `sourceUserId` varchar(191) NOT NULL,
  `targetUserId` varchar(191) NOT NULL,
  `eventName` varchar(255) NOT NULL,
  `payload` json NOT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'PENDING',
  `attempts` int NOT NULL DEFAULT 0,
  `lastError` text NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `publishedAt` timestamp(3) NULL,
  `updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `PurchaseTransferOutbox_transfer_event_uq` (`purchaseUserTransferId`,`eventName`),
  KEY `PurchaseTransferOutbox_status_idx` (`status`)
);
