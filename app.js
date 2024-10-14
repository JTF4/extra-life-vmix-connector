const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const extraLifeApi = require('extra-life-api');
const sqlite3 = require('sqlite3').verbose();  // SQLite database
const XLSX = require('xlsx');
const http = require('http');
const socketIo = require('socket.io');  // Import socket.io
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);  // Create an HTTP server for socket.io
const io = socketIo(server);  // Attach socket.io to the server

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());  // Parse JSON bodies
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const teamId = '67141';  // Extra Life Team ID

// Get userData path from the environment variable
const userDataPath = process.env.USER_DATA_PATH || __dirname;  // Fallback to __dirname for development

// Define paths for config.json and database.db in the userData directory
const configPath = path.join(userDataPath, 'config.json');
const dbPath = path.join(userDataPath, 'database.db');

const port = process.env.PORT || 4400;

// Default configuration settings
const defaultConfig = {
    exportSettings: {
        filePath: './exports',
        fileName: 'donations',
        exportFormat: 'csv'
    }
};

// Ensure config.json exists or create it with default settings
if (!fs.existsSync(configPath)) {
    console.log('config.json not found, creating with default settings...');
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 4));
}

let config = JSON.parse(fs.readFileSync(configPath));

// Declare a global `db` variable
let db;

// Initialize the SQLite database
function initializeDatabase() {
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('Error opening database:', err.message);
        } else {
            console.log('Connected to SQLite database.');
            db.run(`CREATE TABLE IF NOT EXISTS donations (
                id TEXT PRIMARY KEY,
                name TEXT,
                recipient TEXT,
                amount REAL,
                message TEXT,
                avatar TEXT,
                approved INTEGER DEFAULT 0,
                denied INTEGER DEFAULT 0,
                shown INTEGER DEFAULT 0
            )`, (err) => {
                if (err) {
                    console.error('Error creating donations table:', err.message);
                } else {
                    console.log('Donations table created or already exists.');
                }
            });
        }
    });
}

// Initialize the database at startup
initializeDatabase();

// Helper to ensure directory exists
const ensureDirectoryExists = (filePath) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

// Helper to add file extension based on format
const addFileExtension = (fileName, format) => {
    const ext = format === 'excel' ? '.xlsx' : '.csv';
    if (!fileName.endsWith(ext)) {
        return fileName.replace(/\.(xlsx|csv)$/, '') + ext;
    }
    return fileName;
};

// Helper to update CSV file with donation
const updateCSVFile = (donation) => {
    const filePath = path.join(config.exportSettings.filePath, config.exportSettings.fileName);
    ensureDirectoryExists(filePath);

    const csvLine = `${donation.id},${donation.name},${donation.recipient},${donation.amount},${donation.message || 'No message'},${donation.avatar}\n`;
    fs.appendFile(filePath, csvLine, (err) => {
        if (err) console.error("Error updating CSV file:", err);
    });
};

// Helper function to update Excel file with donation
const updateExcelFile = (donation) => {
    const filePath = path.join(config.exportSettings.filePath, config.exportSettings.fileName);

    ensureDirectoryExists(filePath);

    let wb = fs.existsSync(filePath) ? XLSX.readFile(filePath) : XLSX.utils.book_new();

    let ws;
    if (wb.SheetNames.includes('Donations')) {
        ws = wb.Sheets['Donations'];
    } else {
        ws = XLSX.utils.aoa_to_sheet([['ID', 'Name', 'Recipient', 'Amount', 'Message', 'Avatar']]);
        XLSX.utils.book_append_sheet(wb, ws, 'Donations');
    }

    XLSX.utils.sheet_add_aoa(ws, [[donation.id, donation.name, donation.recipient, donation.amount, donation.message || 'No message', donation.avatar]], { origin: -1 });

    XLSX.writeFile(wb, filePath);
};

// Emit new donations via WebSocket when they are fetched or inserted
const fetchDonations = async () => {
    try {
        const response = await extraLifeApi.getTeamDonations(teamId);
        const donations = response.donations || [];
        donations.forEach(donation => {
            db.run(
                `INSERT OR IGNORE INTO donations (id, name, recipient, amount, message, avatar) VALUES (?, ?, ?, ?, ?, ?)`,
                [donation.donationID, donation.displayName, donation.recipientName || 'No recipient', donation.amount, donation.message || '', donation.avatarImageURL],
                (err) => {
                    if (err) {
                        console.error("Error inserting donation:", err.message);
                    } else {
                        // Emit the correct donation object to clients
                        io.emit('new_donation', {
                            id: donation.donationID,
                            name: donation.displayName,
                            recipient: donation.recipientName || 'No recipient',
                            amount: donation.amount || 0,
                            message: donation.message || 'No message',
                            avatar: donation.avatarImageURL || 'https://via.placeholder.com/50'  // Default avatar
                        });
                    }
                }
            );
        });
        console.log('Fetched and inserted new donations.');
    } catch (error) {
        console.error('Error fetching donations:', error);
    }
};

// Approve donation and update export file
const approveDonation = (donationId) => {
    db.get(`SELECT * FROM donations WHERE id = ?`, [donationId], (err, donation) => {
        if (err) return console.error("Error fetching donation:", err.message);
        db.run(`UPDATE donations SET approved = 1 WHERE id = ?`, [donationId], (err) => {
            if (err) return console.error("Error approving donation:", err.message);
            const format = config.exportSettings.exportFormat;
            if (format === 'csv') updateCSVFile(donation);
            else if (format === 'excel') updateExcelFile(donation);
        });
    });
};

// Deny donation
const denyDonation = (donationId) => {
    db.run(`UPDATE donations SET denied = 1, approved = 0 WHERE id = ?`, [donationId], (err) => {
        if (err) console.error("Error denying donation:", err.message);
    });
};

// Get unapproved donations
app.get('/', async (req, res) => {
    await fetchDonations();  // Fetch donations from the API
    db.all(`SELECT * FROM donations WHERE approved = 0 AND denied = 0 AND shown = 0`, [], (err, donations) => {
        if (err) return console.error("Error fetching unapproved donations:", err.message);
        res.render('index', { donations });
    });
});
// Render settings page
app.get('/settings', (req, res) => {
    res.render('settings', {
        title: 'Settings',
        teamId: config.teamId || teamId,  // Display the current team ID from config
        exportSettings: config.exportSettings
    });
});

// Handle settings form submission
app.post('/settings', (req, res) => {
    const { exportFilePath, exportFileName, exportFormat, teamId } = req.body;

    // Update config settings
    config.exportSettings.filePath = exportFilePath;
    config.exportSettings.fileName = addFileExtension(exportFileName, exportFormat);
    config.exportSettings.exportFormat = exportFormat;
    config.teamId = teamId;  // Save the team ID from the form

    // Save updated settings to config.json
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));

    res.redirect('/settings');
});

// Clear database route (with confirmation)
app.post('/clear-database', (req, res) => {
    db.run(`DELETE FROM donations`, (err) => {
        if (err) {
            console.error("Error clearing the database:", err.message);
            res.status(500).json({ success: false, message: "Error clearing the database" });
        } else {
            console.log("All donations cleared from the database.");
            res.json({ success: true });
        }
    });
});

// Path to the exported file (CSV or Excel)
app.post('/open-export-file', (req, res) => {
    // Ensure that the exported file path and file name are correctly set from the config
    const exportFilePath = path.join(config.exportSettings.filePath, config.exportSettings.fileName);

    // Use `exec` to open the export file with the default application
    let command;
    if (process.platform === 'win32') {
        command = `start "" "${exportFilePath}"`;  // Windows
    } else if (process.platform === 'darwin') {
        command = `open "${exportFilePath}"`;  // macOS
    } else {
        command = `xdg-open "${exportFilePath}"`;  // Linux
    }

    exec(command, (err) => {
        if (err) {
            console.error('Error opening the export file:', err);
            res.status(500).json({ success: false, message: 'Error opening the export file' });
        } else {
            res.json({ success: true, message: 'Export file opened' });
        }
    });
});


// Route to render the test control page
app.get('/test', (req, res) => {
    res.render('test', { title: 'Test Control Page' });
});

// Manually add test donations and emit them to clients via WebSocket
app.post('/test/insertDonation', (req, res) => {
    const { donationID, displayName, recipientName, amount, message, avatarImageURL } = req.body;

    const newDonation = {
        id: donationID || `TEST${Math.floor(Math.random() * 10000)}`,  // Generate unique ID for test donations
        name: displayName || 'Test Donor',
        recipient: recipientName || 'Test Recipient',
        amount: amount || 50,
        message: message || 'This is a test donation.',
        avatar: avatarImageURL || 'https://via.placeholder.com/50'  // Default avatar for test
    };

    db.run(
        `INSERT OR IGNORE INTO donations (id, name, recipient, amount, message, avatar) VALUES (?, ?, ?, ?, ?, ?)`,
        [newDonation.id, newDonation.name, newDonation.recipient, newDonation.amount, newDonation.message, newDonation.avatar],
        function(err) {
            if (err) {
                console.error("Error inserting test donation into database:", err.message);
                res.status(500).json({ success: false, error: err.message });
            } else {
                io.emit('new_donation', newDonation);  // Emit to all clients
                console.log("Test donation inserted:", this.lastID);
                res.json({ success: true, id: this.lastID });
            }
        }
    );
});


// Cleanup route to remove all test donations
app.post('/test/cleanup', (req, res) => {
    db.run(`DELETE FROM donations WHERE id LIKE 'TEST%'`, function(err) {
        if (err) {
            console.error("Error cleaning up test donations:", err.message);
            res.status(500).json({ success: false, error: err.message });
        } else {
            console.log("Test donations cleaned up.");
            res.json({ success: true, deletedRows: this.changes });
        }
    });
});

// Approve donation via POST
app.post('/approve', (req, res) => {
    const donationId = req.body.donationId;
    if (!donationId) return res.status(400).json({ success: false, message: "Donation ID is required" });
    approveDonation(donationId);
    res.json({ success: true });
});

// Deny donation via POST
app.post('/deny', (req, res) => {
    const donationId = req.body.donationId;
    if (!donationId) return res.status(400).json({ success: false, message: "Donation ID is required" });
    denyDonation(donationId);
    res.json({ success: true });
});

// Route to get unapproved donations in JSON format for dynamic updates
app.get('/api/getNewDonations', (req, res) => {
    db.all(`SELECT * FROM donations WHERE approved = 0 AND denied = 0 AND shown = 0`, [], (err, rows) => {
        if (err) {
            console.error("Error fetching new donations:", err.message);
            res.status(500).json({ success: false, error: err.message });
        } else {
            res.json({ success: true, donations: rows });
        }
    });
});

// Start the server
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
