require('dotenv').config();
const express = require('express');
const cors = require('cors');
const walletRouter = require('./routes/wallet');
const aiRouter = require('./routes/ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'snbx-billing-api', ts: new Date().toISOString() });
});

app.use('/api/wallet', walletRouter);
app.use('/api/ai', aiRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`SNBX Billing API running on port ${PORT}`);
});
