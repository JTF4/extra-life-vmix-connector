const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./donations.db');

// Initialize the database table
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS donations (
            id TEXT PRIMARY KEY,
            name TEXT,
            amount REAL,
            message TEXT,
            avatar TEXT,
            approved INTEGER DEFAULT 0,
            denied INTEGER DEFAULT 0,
            shown INTEGER DEFAULT 0,
            timestamp TEXT
        )
    `);
});

module.exports = db;
