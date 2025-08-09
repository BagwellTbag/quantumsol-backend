const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { PublicKey } = require('@solana/web3.js');
const Datastore = require('nedb');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Hardcoded admin Solana wallet address and password
const ADMIN_WALLET_ADDRESS = 'GcV16xEPGTkfm1DsDTi7Req1wjfkfm5U4Bgtot4QHUgP'; // Replace with your Solana address
const ADMIN_PASSWORD = '45401626'; // Replace with your secure password

// Validate admin address
try {
    new PublicKey(ADMIN_WALLET_ADDRESS);
} catch (error) {
    console.error('Invalid Solana admin address:', error);
    process.exit(1);
}

// Initialize NeDB databases
const profitsDb = new Datastore({ filename: './profits.db', autoload: true });
const transactionsDb = new Datastore({ filename: './transactions.db', autoload: true });
const withdrawalsDb = new Datastore({ filename: './withdrawals.db', autoload: true });
const depositsDb = new Datastore({ filename: './deposits.db', autoload: true });

// Fetch prices from Jupiter Quote API
app.get('/prices', async (req, res) => {
    try {
        const inputMint = 'So11111111111111111111111111111111111111112'; // SOL mint
        const outputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mint
        const amount = 1_000_000; // 1 SOL (in lamports)
        const dexes = ['Orca', 'Raydium'];
        const prices = {};

        for (const dex of dexes) {
            try {
                const response = await axios.get(
                    `https://quote-api.jup.ag/v6/quote`,
                    {
                        params: {
                            inputMint,
                            outputMint,
                            amount,
                            swapMode: 'ExactIn',
                            onlyDirectRoutes: false,
                            platformFeeBps: 0,
                            dexes: dex
                        },
                        timeout: 5000
                    }
                );
                prices[dex.toLowerCase()] = response.data.outAmount / 1_000_000;
            } catch (dexError) {
                console.error(`Error fetching price for ${dex}:`, dexError.message);
                prices[dex.toLowerCase()] = 0;
            }
        }

        console.log('Fetched prices:', prices);

        const opportunities = [];
        const basePrice = prices['orca'];
        if (basePrice > 0) {
            for (const dex in prices) {
                const price = prices[dex];
                if (price > 0) {
                    const profitMargin = ((price - basePrice) / basePrice) * 100;
                    if (profitMargin >= 12) {
                        opportunities.push({
                            buyDex: 'orca',
                            buyPrice: basePrice,
                            sellDex: dex,
                            sellPrice: price,
                            profitMargin: profitMargin.toFixed(2)
                        });
                    }
                }
            }
        }

        if (Object.keys(prices).length === 0) {
            return res.json({ prices: { orca: 0, raydium: 0 }, opportunities: [] });
        }

        res.json({ prices, opportunities });
    } catch (error) {
        console.error('Price fetch error:', error.message);
        res.status(500).json({ prices: { orca: 0, raydium: 0 }, opportunities: [], error: 'Failed to fetch prices' });
    }
});

// Return wallet address
app.get('/wallet', (req, res) => {
    res.json({ address: ADMIN_WALLET_ADDRESS });
});

// Get user profits
app.get('/profits/:userId', (req, res) => {
    const userId = req.params.userId;
    profitsDb.findOne({ userId }, (err, doc) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ profits: doc ? doc.profits : 0 });
    });
});

// Admin updates user profits
app.post('/update-profits', (req, res) => {
    const { userId, profits, password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid admin password' });
    }
    profitsDb.update(
        { userId },
        { userId, profits },
        { upsert: true },
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            transactionsDb.insert({
                userId,
                type: 'profit',
                amount: profits,
                timestamp: new Date().toISOString()
            });
            res.json({ message: 'Profits updated successfully' });
        }
    );
});

// Get transaction history
app.get('/transactions/:userId', (req, res) => {
    const userId = req.params.userId;
    transactionsDb.find({ userId }).sort({ timestamp: -1 }).exec((err, docs) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ transactions: docs });
    });
});

// Submit withdrawal request
app.post('/withdraw', (req, res) => {
    const { userId, amount, address } = req.body;
    try {
        new PublicKey(address); // Validate Solana address
        withdrawalsDb.insert({
            userId,
            amount,
            address,
            status: 'pending',
            timestamp: new Date().toISOString()
        }, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            transactionsDb.insert({
                userId,
                type: 'withdrawal_request',
                amount,
                address,
                timestamp: new Date().toISOString()
            });
            res.json({ message: 'Withdrawal request submitted' });
        });
    } catch (error) {
        res.status(400).json({ error: 'Invalid Solana address' });
    }
});

// Admin logs a deposit
app.post('/log-deposit', (req, res) => {
    const { userId, amount, currency, txId, password } = req.body;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid admin password' });
    }
    depositsDb.insert({
        userId,
        amount,
        currency, // 'SOL' or 'USDC'
        txId: txId || 'N/A',
        timestamp: new Date().toISOString()
    }, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        transactionsDb.insert({
            userId,
            type: 'deposit',
            amount,
            currency,
            txId: txId || 'N/A',
            timestamp: new Date().toISOString()
        });
        res.json({ message: 'Deposit logged successfully' });
    });
});

// Get user deposits
app.get('/deposits/:userId', (req, res) => {
    const userId = req.params.userId;
    depositsDb.find({ userId }).sort({ timestamp: -1 }).exec((err, docs) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deposits: docs });
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));