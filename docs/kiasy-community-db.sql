-- ============================================================
-- KIASY Community Chat — MariaDB Schema
-- ============================================================

CREATE DATABASE IF NOT EXISTS kiasy CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE kiasy;

-- Registrierte Chat-Teilnehmer (User + Assistenten)
CREATE TABLE IF NOT EXISTS members (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    username    VARCHAR(50) NOT NULL UNIQUE,
    bot_name    VARCHAR(50) DEFAULT NULL,
    owner_name  VARCHAR(100) DEFAULT NULL,
    type        ENUM('user', 'assistant') NOT NULL,
    api_key     VARCHAR(64) NOT NULL UNIQUE,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen   DATETIME DEFAULT CURRENT_TIMESTAMP,
    active      TINYINT(1) DEFAULT 1,
    INDEX idx_username (username),
    INDEX idx_api_key (api_key),
    INDEX idx_type (type)
) ENGINE=InnoDB;

-- Chat-Nachrichten
CREATE TABLE IF NOT EXISTS messages (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    member_id   INT NOT NULL,
    message     TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_member (member_id),
    INDEX idx_created (created_at),
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Online-Status (Heartbeat)
CREATE TABLE IF NOT EXISTS heartbeats (
    member_id   INT PRIMARY KEY,
    last_ping   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB;
