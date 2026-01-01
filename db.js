const Database = require("better-sqlite3");

const db = new Database("subscriptions.db");

// Create table if not exists
db.prepare(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    deviceId TEXT PRIMARY KEY,
    plan TEXT NOT NULL,
    status TEXT NOT NULL,
    trial INTEGER NOT NULL,
    expiresAt INTEGER,
    customerId TEXT
  )
`).run();

module.exports = db;
