const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const extraLifeApi = require('extra-life-api');
const sqlite3 = require('sqlite3').verbose();
const XLSX = require('xlsx');
const http = require('http');
const socketIo = require('socket.io');
const { exec } = require('child_process');
const { app: electronApp, shell } = require('electron'); // Make sure Electron app is properly required

const expressApp = express();
const server = http.createServer(expressApp);
const io = socketIo(server);

// Middleware and settings
expressApp.use(bodyParser.urlencoded({ extended: true }));
expressApp.use(express.json());
expressApp.set('view engine', 'ejs');
expressApp.set('views', path.join(__dirname, 'views'));

// Declare variables
let config = {};
let db;
const teamId = '67141';  // Default Extra Life Team ID
let dbPath, configPath;



// Wait for the Electron app to be ready before proceeding
electronApp.whenReady().then(() => {
    // Get the userData directory from Electron
    userDataPath = electronApp.getPath('userData');
    configPath = path.join(userDataPath, 'config.json');
    dbPath = path.join(userDataPath, 'database.db');

    // Default configuration settings
    const defaultConfig = {
        exportSettings: {
            filePath: './exports',
            fileName: 'donations',
            exportFormat: 'csv'
        },
        teamId: teamId
    };

    // Ensure config.json exists or create it with default settings
    if (!fs.existsSync(configPath)) {
        console.log('config.json not found, creating with default settings...');
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 4));
    }

    // Load settings from config.json
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Initialize the SQLite database
    initializeDatabase();

    // Start the server
    const port = process.env.PORT || 4400;
    server.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
    });
}).catch(err => {
    console.error('Failed to initialize the app:', err);
});

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

// Function to ensure a directory exists
const ensureDirectoryExists = (directory) => {
    const dirPath = path.join(userDataPath, directory); // Combine userDataPath with directory

    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });  // Ensure the directory exists
    }
};

// Helper function to add a file extension based on format
const addFileExtension = (fileName, format) => {
    const ext = format === 'excel' ? '.xlsx' : '.csv';
    if (!fileName.endsWith(ext)) {
        return fileName.replace(/\.(xlsx|csv)$/, '') + ext;
    }
    return fileName;
};

// Helper function to update CSV file
const updateCSVFile = (donation) => {
    const directory = 'exports';  // Directory where you want to store the exports
    const fileName = addFileExtension(config.exportSettings.fileName, config.exportSettings.exportFormat);

    // Ensure that the export directory exists in the user's data directory
    ensureDirectoryExists(directory);

    // Use the user data path for storing exports
    const filePath = path.join(userDataPath, directory, fileName);

    // Prepare CSV line for donation
    const csvLine = `${donation.id},${donation.name},${donation.recipient},${donation.amount},${donation.message || 'No message'},${donation.avatar}\n`;

    // Append the donation data to the CSV file
    fs.appendFile(filePath, csvLine, (err) => {
        if (err) {
            console.error("Error updating CSV file:", err);
        } else {
            console.log("CSV file updated with new donation.");
        }
    });
};

// Helper function to update Excel file
const updateExcelFile = (donation) => {
    const directory = 'exports';  // Directory where you want to store the exports
    const fileName = addFileExtension(config.exportSettings.fileName, config.exportSettings.exportFormat);

    // Ensure that the export directory exists in the user's data directory
    ensureDirectoryExists(directory);

    // Use the user data path for storing exports
    const filePath = path.join(userDataPath, directory, fileName);

    // Read existing workbook or create a new one
    let wb;
    if (fs.existsSync(filePath)) {
        wb = XLSX.readFile(filePath);
    } else {
        wb = XLSX.utils.book_new();
    }

    // Check if the sheet 'Donations' exists or create a new one
    let ws = wb.Sheets['Donations'] || XLSX.utils.aoa_to_sheet([['ID', 'Name', 'Recipient', 'Amount', 'Message', 'Avatar']]);

    // Add new donation to the sheet
    XLSX.utils.sheet_add_aoa(ws, [[donation.id, donation.name, donation.recipient, donation.amount, donation.message || 'No message', donation.avatar]], { origin: -1 });

    // Append sheet to the workbook if it's new
    XLSX.utils.book_append_sheet(wb, ws, 'Donations');

    // Write the updated workbook to file
    XLSX.writeFile(wb, filePath);
};

// Emit new donations via WebSocket when they are fetched or inserted
const fetchDonations = async () => {
    try {
        const response = await extraLifeApi.getTeamDonations(config.teamId || teamId);
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

// Routes to handle donations and settings
expressApp.get('/', async (req, res) => {
    await fetchDonations();
    db.all(`SELECT * FROM donations WHERE approved = 0 AND denied = 0 AND shown = 0`, [], (err, donations) => {
        if (err) return console.error("Error fetching unapproved donations:", err.message);
        res.render('index', { donations });
    });
});

// Render settings page
expressApp.get('/settings', (req, res) => {
    res.render('settings', {
        title: 'Settings',
        teamId: config.teamId || teamId,
        exportSettings: config.exportSettings
    });
});

// Handle settings form submission
expressApp.post('/settings', (req, res) => {
    const { exportFilePath, exportFileName, exportFormat, teamId } = req.body;
    config.exportSettings.filePath = exportFilePath;
    config.exportSettings.fileName = addFileExtension(exportFileName, exportFormat);
    config.exportSettings.exportFormat = exportFormat;
    config.teamId = teamId;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    res.redirect('/settings');
});

// Clear database route (with confirmation)
expressApp.post('/clear-database', (req, res) => {
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

// Open export file
expressApp.post('/open-export-file', (req, res) => {
    const exportFilePath = path.join(config.exportSettings.filePath, config.exportSettings.fileName);
    let command;
    if (process.platform === 'win32') {
        command = `start "" "${exportFilePath}"`;
    } else if (process.platform === 'darwin') {
        command = `open "${exportFilePath}"`;
    } else {
        command = `xdg-open "${exportFilePath}"`;
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

// WebSocket routes for new donations, test donations, and cleanup
expressApp.get('/test', (req, res) => {
    res.render('test', { title: 'Test Control Page' });
});

expressApp.post('/test/insertDonation', (req, res) => {
    const { donationID, displayName, recipientName, amount, message, avatarImageURL } = req.body;
    const newDonation = {
        id: donationID || `TEST${Math.floor(Math.random() * 10000)}`,
        name: displayName || 'Test Donor',
        recipient: recipientName || 'Test Recipient',
        amount: amount || 50,
        message: message || 'This is a test donation.',
        avatar: avatarImageURL || 'https://via.placeholder.com/50'
    };
    db.run(`INSERT OR IGNORE INTO donations (id, name, recipient, amount, message, avatar) VALUES (?, ?, ?, ?, ?, ?)`, [newDonation.id, newDonation.name, newDonation.recipient, newDonation.amount, newDonation.message, newDonation.avatar], function(err) {
        if (err) {
            console.error("Error inserting test donation into database:", err.message);
            res.status(500).json({ success: false, error: err.message });
        } else {
            io.emit('new_donation', newDonation);
            console.log("Test donation inserted:", this.lastID);
            res.json({ success: true, id: this.lastID });
        }
    });
});

expressApp.post('/test/cleanup', (req, res) => {
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
expressApp.post('/approve', (req, res) => {
    const donationId = req.body.donationId;  // Extract donation ID from request body
    if (!donationId) return res.status(400).json({ success: false, message: "Donation ID is required" });

    approveDonation(donationId);  // Call your approval function (ensure this function is implemented)
    res.json({ success: true });  // Respond with success
});

// Deny donation via POST
expressApp.post('/deny', (req, res) => {
    const donationId = req.body.donationId;  // Extract donation ID from request body
    if (!donationId) return res.status(400).json({ success: false, message: "Donation ID is required" });

    denyDonation(donationId);  // Call your denial function (ensure this function is implemented)
    res.json({ success: true });  // Respond with success
});

// Open the directory where the exported CSV or Excel file is located
expressApp.post('/open-export-directory', (req, res) => {
    const exportFilePath = path.join(config.exportSettings.filePath);
    
    // Use Electron's shell to open the directory in Finder or File Explorer
    shell.openPath(exportFilePath).then(() => {
        res.json({ success: true, message: 'Directory opened' });
    }).catch((err) => {
        console.error('Error opening directory:', err);
        res.status(500).json({ success: false, message: 'Error opening directory' });
    });
});


// Fetch new donations via API and dynamic updates using WebSocket
expressApp.get('/api/getNewDonations', (req, res) => {
    db.all(`SELECT * FROM donations WHERE approved = 0 AND denied = 0 AND shown = 0`, [], (err, rows) => {
        if (err) {
            console.error("Error fetching new donations:", err.message);
            res.status(500).json({ success: false, error: err.message });
        } else {
            res.json({ success: true, donations: rows });
        }
    });
});

module.exports = expressApp;
// Initialize the Express app and pass in userDataPath
module.exports.init = (config) => {
    userDataPath = config.userDataPath;  // Set userDataPath from main.js
};
