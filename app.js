const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const extraLifeApi = require('extra-life-api');
const db = require('./database'); // Import the SQLite database
const XLSX = require('xlsx');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const teamId = '67141';

// Default configuration settings
const defaultConfig = {
    exportSettings: {
        filePath: './exports',
        fileName: 'donations',  // Default without extension
        exportFormat: 'csv'  // Default to CSV
    }
};

// Path to config.json
const configPath = path.join(__dirname, 'config.json');

// Check if config.json exists, and create it with default settings if it doesn't
if (!fs.existsSync(configPath)) {
    console.log('config.json not found, creating with default settings...');
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 4));
}

// Load settings from config.json
let config = JSON.parse(fs.readFileSync(configPath));

// Helper function to add correct extension based on format
const addFileExtension = (fileName, format) => {
    const ext = format === 'excel' ? '.xlsx' : '.csv';
    if (!fileName.endsWith(ext)) {
        return fileName + ext;
    }
    return fileName;
};

// Fetch donations and save them to the database if not already present
const fetchDonations = async () => {
    try {
        const response = await extraLifeApi.getTeamDonations(teamId);
        const donations = response.donations;
        
        // Log the donations from the API response
        console.log("Fetched Donations from API:", donations);
        
        if (Array.isArray(donations)) {
            donations.forEach(donation => {
                db.run(
                    `INSERT OR IGNORE INTO donations (id, name, recipient, amount, message, avatar) VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        donation.donationID,
                        donation.displayName,
                        donation.recipientName || 'No recipient',  // Save the recipient name
                        donation.amount,
                        donation.message || '',
                        donation.avatarImageURL
                    ],
                    function(err) {
                        if (err) {
                            console.error("Error inserting donation into database:", err.message);
                        } else {
                            console.log("Donation inserted or already exists:", donation.donationID);
                        }
                    }
                );
            });
        } else {
            console.log("API response donations field is not an array.");
        }
    } catch (error) {
        console.error('Error fetching donations:', error);
    }
};



// Get unapproved donations that haven't been denied or shown
const getUnapprovedDonations = async (callback) => {
    db.all(`SELECT * FROM donations WHERE approved = 0 AND denied = 0 AND shown = 0`, [], (err, rows) => {
        if (err) {
            console.error("Error fetching unapproved donations from database:", err.message);
            callback([]);
        } else {
            console.log("Unapproved Donations:", rows);  // Log unapproved donations
            callback(rows);
        }
    });
};

// Helper function to ensure directory exists
const ensureDirectoryExists = (filePath) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};


// Helper function to update CSV file
const updateCSVFile = (donation) => {
    const filePath = path.join(config.exportSettings.filePath, config.exportSettings.fileName);
    
    ensureDirectoryExists(filePath);

    const csvLine = `${donation.id},${donation.name},${donation.recipient},${donation.amount},${donation.message || 'No message'},${donation.avatar}\n`;

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
    const filePath = path.join(config.exportSettings.filePath, config.exportSettings.fileName);

    ensureDirectoryExists(filePath);

    let wb;
    if (fs.existsSync(filePath)) {
        wb = XLSX.readFile(filePath);
    } else {
        wb = XLSX.utils.book_new();
    }

    const ws = wb.Sheets['Donations'] || XLSX.utils.aoa_to_sheet([['ID', 'Name', 'Recipient', 'Amount', 'Message', 'Avatar']]);
    XLSX.utils.sheet_add_aoa(ws, [[donation.id, donation.name, donation.recipient, donation.amount, donation.message || 'No message', donation.avatar]], { origin: -1 });

    XLSX.utils.book_append_sheet(wb, ws, 'Donations');
    XLSX.writeFile(wb, filePath);
};

// Approve donation and update the export file
const approveDonation = (donationId) => {
    db.get(`SELECT * FROM donations WHERE id = ?`, [donationId], (err, donation) => {
        if (err) {
            console.error("Error fetching donation:", err.message);
            return;
        }
        db.run(`UPDATE donations SET approved = 1 WHERE id = ?`, [donationId], (err) => {
            if (err) {
                console.error("Error approving donation:", err.message);
            } else {
                const format = config.exportSettings.exportFormat;
                if (format === 'csv') {
                    updateCSVFile(donation);
                } else if (format === 'excel') {
                    updateExcelFile(donation);
                }
            }
        });
    });
};




// Mark donation as shown and trigger vMix
const markAsShown = (donationId) => {
    db.get(`SELECT * FROM donations WHERE id = ?`, [donationId], (err, donation) => {
        if (err) {
            console.error("Error fetching donation:", err.message);
            return;
        }
        db.run(`UPDATE donations SET shown = 1 WHERE id = ?`, [donationId], function(err) {
            if (err) {
                console.error("Error marking donation as shown:", err.message);
            } else {
                console.log(`Donation ${donationId} marked as shown.`);
                // Send to vMix based on whether there's a message or not
                handleVmixTitle(donation, vmixTitleWithMessage, vmixTitleNoMessage);
            }
        });
    });
};


// Deny donation
const denyDonation = (donationId) => {
    db.run(`UPDATE donations SET denied = 1, approved = 0 WHERE id = ?`, [donationId], function(err) {
        if (err) {
            console.error("Error denying donation:", err.message);
        } else {
            console.log(`Donation ${donationId} denied`);
        }
    });
};

// Endpoint to display the donation queue for approval
app.get('/', async (req, res) => {
    await fetchDonations();  // Fetch donations from the API
    getUnapprovedDonations((donations) => {
        res.render('index', { donations });
    });
});

// Add middleware to parse JSON body
app.use(express.json());

// Handle approval of donations
app.post('/approve', (req, res) => {
    const donationId = req.body.donationId;  // Extract the donationId from the request body
    if (!donationId) {
        return res.status(400).json({ success: false, message: "Donation ID is required" });
    }
    approveDonation(donationId);
    res.json({ success: true });
});

// Handle denial of donations
app.post('/deny', (req, res) => {
    const donationId = req.body.donationId;  // Extract the donationId from the request body
    if (!donationId) {
        return res.status(400).json({ success: false, message: "Donation ID is required" });
    }
    denyDonation(donationId);
    res.json({ success: true });
});

// Mark donation as shown
app.post('/markAsShown', (req, res) => {
    const donationId = req.body.donationId;  // Extract the donationId from the request body
    if (!donationId) {
        return res.status(400).json({ success: false, message: "Donation ID is required" });
    }
    markAsShown(donationId);
    res.json({ success: true });
});

let exportSettings = {
    filePath: './exports',  // Default file path
    fileName: 'donations.csv'      // Default file name
};

// Route to render settings page
app.get('/settings', (req, res) => {
    res.render('settings', {
        title: 'Export Settings',
        exportSettings: config.exportSettings
    });
});

// Route to handle settings form submission
app.post('/settings', (req, res) => {
    const { exportFilePath, exportFileName, exportFormat } = req.body;

    // Add correct extension to the file name
    const fileNameWithExt = addFileExtension(exportFileName, exportFormat);

    // Update config settings
    config.exportSettings.filePath = exportFilePath;
    config.exportSettings.fileName = fileNameWithExt;
    config.exportSettings.exportFormat = exportFormat;

    // Save updated settings to config.json
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));

    res.redirect('/settings');
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
            donationID || `TEST${Math.floor(Math.random() * 10000)}`, // Unique ID for each test
            displayName || 'Test Donor',
            recipientName || 'Test Recipient',
            amount || 50,
            message || 'This is a test donation.',
            avatarImageURL || 'https://placekitten.com/50/50'
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
    db.run(`DELETE FROM donations WHERE id LIKE 'TEST%' OR id LIKE 'MOCK%'`, function(err) {
        if (err) {
            console.error("Error cleaning up test donations:", err.message);
            res.status(500).json({ success: false, error: err.message });
        } else {
            console.log("Test donations cleaned up.");
            res.json({ success: true, deletedRows: this.changes });
        }
    });
});


// Start the server on port 4400
app.listen(4400, () => {
    console.log('Server running on http://localhost:4400');
});
