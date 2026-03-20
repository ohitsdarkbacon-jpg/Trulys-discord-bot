// backend/server.js
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

const USERS_FILE = './users.json';
let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE)) : {};

// --------------------
// PAYPAL WEBHOOK
// --------------------
app.post('/paypal-webhook', (req, res) => {
    try {
        const { userId, amount, status } = req.body;
        if (status !== 'COMPLETED') return res.sendStatus(200);

        if (!users[userId]) users[userId] = { credits: 0 };
        users[userId].credits += amount;

        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        console.log(`✅ PayPal: Added ${amount} credits to ${userId}`);
        res.sendStatus(200);
    } catch (err) {
        console.error('PayPal webhook error:', err);
        res.sendStatus(500);
    }
});

// --------------------
// CRYPTO WEBHOOK (Coinbase Commerce)
// --------------------
app.post('/crypto-webhook', (req, res) => {
    try {
        const event = req.body.event;
        if (!event || event.type !== 'charge:confirmed') return res.sendStatus(200);

        const userId = event.data.metadata.userId;
        const amount = parseInt(event.data.metadata.credits);

        if (!users[userId]) users[userId] = { credits: 0 };
        users[userId].credits += amount;

        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        console.log(`✅ Crypto: Added ${amount} credits to ${userId}`);
        res.sendStatus(200);
    } catch (err) {
        console.error('Crypto webhook error:', err);
        res.sendStatus(500);
    }
});

// --------------------
// START SERVER
// --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`💰 Payment backend running on port ${PORT}`));