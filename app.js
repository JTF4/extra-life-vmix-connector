const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const extraLifeApi = require('extra-life-api');
const db = require('./database');  // SQLite database
const XLSX = require('xlsx');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());  // Parse JSON bodies
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const teamId = '67141';  // Extra Life Team ID
const configPath = path.join(__dirname, 'config.json');
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
    // Use a regular expression to check if the file already has the correct extension
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

    // Read existing file or create a new workbook
    let wb = fs.existsSync(filePath) ? XLSX.readFile(filePath) : XLSX.utils.book_new();

    // Check if the sheet 'Donations' already exists
    let ws;
    if (wb.SheetNames.includes('Donations')) {
        ws = wb.Sheets['Donations'];
    } else {
        ws = XLSX.utils.aoa_to_sheet([['ID', 'Name', 'Recipient', 'Amount', 'Message', 'Avatar']]);
        XLSX.utils.book_append_sheet(wb, ws, 'Donations');
    }

    // Append new donation data
    XLSX.utils.sheet_add_aoa(ws, [[donation.id, donation.name, donation.recipient, donation.amount, donation.message || 'No message', donation.avatar]], { origin: -1 });

    // Write the file
    XLSX.writeFile(wb, filePath);
};

// Fetch donations from Extra Life API and insert into database
const fetchDonations = async () => {
    try {
        const response = await extraLifeApi.getTeamDonations(teamId);
        const donations = response.donations || [];
        donations.forEach(donation => {
            db.run(
                `INSERT OR IGNORE INTO donations (id, name, recipient, amount, message, avatar) VALUES (?, ?, ?, ?, ?, ?)`,
                [donation.donationID, donation.displayName, donation.recipientName || 'No recipient', donation.amount, donation.message || '', donation.avatarImageURL],
                (err) => {
                    if (err) console.error("Error inserting donation:", err.message);
                }
            );
        });
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
    await fetchDonations();
    db.all(`SELECT * FROM donations WHERE approved = 0 AND denied = 0 AND shown = 0`, [], (err, donations) => {
        if (err) return console.error("Error fetching unapproved donations:", err.message);
        res.render('index', { donations });
    });
});

// Route to render the test control page
app.get('/test', (req, res) => {
    res.render('test', { title: 'Test Control Page' });
});

// Test route to insert mock donations for testing purposes
app.post('/test/insertDonation', (req, res) => {
    const { donationID, displayName, recipientName, amount, message, avatarImageURL } = req.body;

    db.run(
        `INSERT OR IGNORE INTO donations (id, name, recipient, amount, message, avatar) VALUES (?, ?, ?, ?, ?, ?)`,
        [
            donationID || `TEST${Math.floor(Math.random() * 10000)}`,  // Generate unique ID for test donations
            displayName || 'Test Donor',
            recipientName || 'Test Recipient',
            amount || 50,
            message || 'This is a test donation.',
            avatarImageURL || 'https://placekitten.com/50/50'  // Default avatar for test
        ],
        function(err) {
            if (err) {
                console.error("Error inserting test donation into database:", err.message);
                res.status(500).json({ success: false, error: err.message });
            } else {
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

// Render settings page
app.get('/settings', (req, res) => {
    res.render('settings', { title: 'Export Settings', exportSettings: config.exportSettings });
});

// Handle settings form submission
app.post('/settings', (req, res) => {
    const { exportFilePath, exportFileName, exportFormat } = req.body;
    config.exportSettings.filePath = exportFilePath;
    config.exportSettings.fileName = addFileExtension(exportFileName, exportFormat);
    config.exportSettings.exportFormat = exportFormat;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    res.redirect('/settings');
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

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

