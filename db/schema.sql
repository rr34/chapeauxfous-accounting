/*M!999999\- enable the sandbox mode */ 
-- MariaDB dump 10.19  Distrib 10.11.14-MariaDB, for debian-linux-gnu (x86_64)
--
-- Host: localhost    Database: cfaccounting
-- ------------------------------------------------------
-- Server version	10.11.14-MariaDB-0ubuntu0.24.04.1

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `accounts`
--

DROP TABLE IF EXISTS `accounts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `accounts` (
  `account_id` int(11) NOT NULL AUTO_INCREMENT,
  `AccountName` text NOT NULL COMMENT 'Can include the description.',
  `parent_account_id` int(11) DEFAULT NULL,
  `AccountType` enum('asset','liability','income','expense','equity') NOT NULL,
  `account_currency_id` int(11) NOT NULL,
  PRIMARY KEY (`account_id`),
  KEY `accounts_currencies_FK` (`account_currency_id`),
  KEY `accounts_accounts_FK` (`parent_account_id`),
  CONSTRAINT `accounts_accounts_FK` FOREIGN KEY (`parent_account_id`) REFERENCES `accounts` (`account_id`) ON UPDATE CASCADE,
  CONSTRAINT `accounts_currencies_FK` FOREIGN KEY (`account_currency_id`) REFERENCES `currencies` (`currency_id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `currencies`
--

DROP TABLE IF EXISTS `currencies`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `currencies` (
  `currency_id` int(11) NOT NULL AUTO_INCREMENT,
  `CurrencyAbbreviation` varchar(50) NOT NULL,
  `scale` tinyint(3) unsigned NOT NULL DEFAULT 2,
  PRIMARY KEY (`currency_id`),
  UNIQUE KEY `currencies_unique` (`CurrencyAbbreviation`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `line_items`
--

DROP TABLE IF EXISTS `line_items`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `line_items` (
  `line_item_id` bigint(20) NOT NULL AUTO_INCREMENT,
  `transaction_id` bigint(20) NOT NULL,
  `amount_units` bigint(20) NOT NULL,
  `memo` text DEFAULT NULL,
  `account_id` int(11) NOT NULL,
  PRIMARY KEY (`line_item_id`),
  KEY `line_items_accounts_FK` (`account_id`),
  KEY `line_items_transactions_FK` (`transaction_id`),
  CONSTRAINT `line_items_accounts_FK` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`account_id`) ON UPDATE CASCADE,
  CONSTRAINT `line_items_transactions_FK` FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`transaction_id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `lineitems_tags_join`
--

DROP TABLE IF EXISTS `lineitems_tags_join`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `lineitems_tags_join` (
  `tagged_line_item_id` bigint(20) NOT NULL,
  `tag_id` int(11) NOT NULL,
  PRIMARY KEY (`tag_id`,`tagged_line_item_id`),
  KEY `lineitems_tags_join_tagged_line_item_id_IDX` (`tagged_line_item_id`,`tag_id`) USING BTREE,
  CONSTRAINT `lineitems_tags_join_line_items_FK` FOREIGN KEY (`tagged_line_item_id`) REFERENCES `line_items` (`line_item_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `lineitems_tags_join_tags_FK` FOREIGN KEY (`tag_id`) REFERENCES `tags` (`tag_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `tags`
--

DROP TABLE IF EXISTS `tags`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `tags` (
  `tag_id` int(11) NOT NULL AUTO_INCREMENT,
  `tag_key` varchar(50) NOT NULL,
  `tag_value` text NOT NULL,
  PRIMARY KEY (`tag_id`),
  UNIQUE KEY `tags_unique` (`tag_key`,`tag_value`) USING HASH
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `transactions`
--

DROP TABLE IF EXISTS `transactions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `transactions` (
  `transaction_id` bigint(20) NOT NULL AUTO_INCREMENT,
  `EnteredAt` datetime NOT NULL DEFAULT current_timestamp(),
  `UpdatedAt` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `description` text DEFAULT NULL,
  `valuation_currency_id` int(11) NOT NULL,
  `TransactionState` enum('draft','posted','voided') NOT NULL DEFAULT 'draft',
  `TransactionDate` date NOT NULL,
  PRIMARY KEY (`transaction_id`),
  KEY `transactions_currencies_FK` (`valuation_currency_id`),
  CONSTRAINT `transactions_currencies_FK` FOREIGN KEY (`valuation_currency_id`) REFERENCES `currencies` (`currency_id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `xrates`
--

DROP TABLE IF EXISTS `xrates`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `xrates` (
  `xrate_id` int(11) NOT NULL AUTO_INCREMENT,
  `xrate_type` enum('transaction','reference') NOT NULL DEFAULT 'reference' COMMENT 'Allows system or user to store reference values to auto-fill xrate values. Actual accounting only looks at the enum type.',
  `ValidAt` datetime DEFAULT NULL COMMENT 'Always store UTC. NULL for transactions, which reference the transaction datetime',
  `transaction_id` bigint(20) DEFAULT NULL COMMENT 'NULL for reference rates',
  `from_units` bigint(20) NOT NULL,
  `from_currency_id` int(11) NOT NULL,
  `to_units` bigint(20) NOT NULL,
  `to_currency_id` int(11) NOT NULL,
  PRIMARY KEY (`xrate_id`),
  UNIQUE KEY `exchange_rates_unique` (`transaction_id`,`from_currency_id`,`to_currency_id`),
  KEY `xrates_transactions_currencies_FK` (`from_currency_id`),
  KEY `xrates_transactions_currencies_FK_1` (`to_currency_id`),
  KEY `xrates_xrate_type_IDX` (`xrate_type`,`from_currency_id`,`to_currency_id`,`ValidAt`) USING BTREE,
  CONSTRAINT `xrates_transactions_currencies_FK` FOREIGN KEY (`from_currency_id`) REFERENCES `currencies` (`currency_id`) ON UPDATE CASCADE,
  CONSTRAINT `xrates_transactions_currencies_FK_1` FOREIGN KEY (`to_currency_id`) REFERENCES `currencies` (`currency_id`) ON UPDATE CASCADE,
  CONSTRAINT `xrates_transactions_transactions_FK` FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`transaction_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-08-23 23:36:50
