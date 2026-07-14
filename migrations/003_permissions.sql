-- Migration 003: user permissions
ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT '[]';
