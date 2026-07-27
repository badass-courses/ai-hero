CREATE TABLE `AI_ValuePathCertificateShare` (
	`id` varchar(255) NOT NULL,
	`slug` varchar(64) NOT NULL,
	`contactId` varchar(255) NOT NULL,
	`resourceId` varchar(255) NOT NULL,
	`learnerName` varchar(255) NOT NULL,
	`courseName` varchar(255) NOT NULL,
	`completedAt` timestamp(3) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `AI_ValuePathCertificateShare_id` PRIMARY KEY (`id`),
	CONSTRAINT `ValuePathCertificateShare_slug_uq` UNIQUE (`slug`),
	CONSTRAINT `ValuePathCertificateShare_contact_resource_uq` UNIQUE (`contactId`, `resourceId`),
	INDEX `ValuePathCertificateShare_contactId_idx` (`contactId`)
);
