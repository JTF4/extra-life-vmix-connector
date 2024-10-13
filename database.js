const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./donations.db');

// Initialize the database table with the necessary columns
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS donations (
            id TEXT PRIMARY KEY,
            name TEXT,
            recipient TEXT,         -- New recipient column
            amount REAL,
            message TEXT,
            avatar TEXT,
            approved INTEGER DEFAULT 0,
            denied INTEGER DEFAULT 0,
            shown INTEGER DEFAULT 0,
            timestamp TEXT
        )
    `, function(err) {
        if (err) {
            console.error("Error creating donations table:", err.message);
        } else {
            console.log("Donations table created or verified successfully.");
        }
    });
});

module.exports = db;
