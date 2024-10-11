const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const extraLifeApi = require('extra-life-api');
const db = require('./database'); // Import the SQLite database

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const teamId = '67141';

// Fetch donations and save them to the database if not already present
const fetchDonations = async () => {
    try {
        const donations = await extraLifeApi.getTeamDonations(teamId);
        
        // Log the donations from the API response
        console.log("Fetched Donations from API:", donations);
        
        if (Array.isArray(donations)) {
            donations.forEach(donation => {
                db.run(
                    `INSERT OR IGNORE INTO donations (id, name, amount, message, avatar) VALUES (?, ?, ?, ?, ?)`,
                    [donation.donationID, donation.displayName, donation.amount, donation.message, donation.avatarImageURL],
                    function(err) {
                        if (err) {
                            console.error("Error inserting donation into database:", err.message);
                        } else {
                            console.log("Donation inserted or already exists:", donation.donationID);
                        }
                    }
                );
            });
        }
    } catch (error) {
        console.error('Error fetching donations:', error);
    }
};

// Get donations that haven't been shown or denied
const getPendingDonations = async (callback) => {
    db.all(`SELECT * FROM donations WHERE approved = 1 AND denied = 0 AND shown = 0`, [], (err, rows) => {
        if (err) {
            console.error("Error fetching pending donations from database:", err.message);
            callback([]);
        } else {
            console.log("Pending Donations:", rows);  // Log the pending donations
            callback(rows);
        }
    });
};

// Approve donation and set timestamp
const approveDonation = (donationId) => {
    const timestamp = new Date().toISOString();
    db.run(`UPDATE donations SET approved = 1, timestamp = ? WHERE id = ?`, [timestamp, donationId]);
};

// Deny donation
const denyDonation = (donationId) => {
    db.run(`UPDATE donations SET denied = 1 WHERE id = ?`, [donationId]);
};

// Mark donation as shown
const markAsShown = (donationId) => {
    db.run(`UPDATE donations SET shown = 1 WHERE id = ?`, [donationId]);
};

// Endpoint to display the donation queue
app.get('/', async (req, res) => {
    await fetchDonations();  // Fetch donations from the API
    getPendingDonations((donations) => {
        res.render('index', { donations });
    });
});

// Handle approval of donations
app.post('/approve', (req, res) => {
    const donationId = req.body.donationId;
    approveDonation(donationId);
    res.redirect('/');
});

// Handle denial of donations
app.post('/deny', (req, res) => {
    const donationId = req.body.donationId;
    denyDonation(donationId);
    res.redirect('/');
});

// Mark donation as shown
app.post('/markAsShown', (req, res) => {
    const donationId = req.body.donationId;
    markAsShown(donationId);
    res.redirect('/');
});

// Start the server on port 4400
app.listen(4400, () => {
    console.log('Server running on http://localhost:4400');
});
