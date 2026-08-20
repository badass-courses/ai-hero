CREATE TABLE `AI_CheckoutLoginHandoff` (
  `nonceHash` varchar(64) NOT NULL,
  `browserSessionHash` varchar(64) NOT NULL,
  `country` varchar(2) NOT NULL,
  `productId` varchar(255) NOT NULL,
  `quantity` int NOT NULL,
  `pppSelected` boolean NOT NULL,
  `state` varchar(32) NOT NULL,
  `boundUserId` varchar(255) NULL,
  `claimId` varchar(64) NULL,
  `checkoutRedirect` text NULL,
  `issuedAt` timestamp(3) NOT NULL,
  `expiresAt` timestamp(3) NOT NULL,
  `completedAt` timestamp(3) NULL,
  `updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`nonceHash`),
  KEY `CheckoutLoginHandoff_expiresAt_idx` (`expiresAt`),
  KEY `CheckoutLoginHandoff_state_idx` (`state`)
);
