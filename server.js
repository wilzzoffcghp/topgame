const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const { GitHubDB } = require('./github-db');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// DB instances
const usersDB = new GitHubDB('users.json');
const transactionsDB = new GitHubDB('transactions.json');
const depositsDB = new GitHubDB('deposits.json');
const resellersDB = new GitHubDB('resellers.json');

const ZUAN_API_KEY = process.env.ZUAN_API_KEY;
const DIGITALPEDIA_BASE = process.env.DIGITALPEDIA_BASE_URL;
const MARKUP = parseInt(process.env.MARKUP) || 1000;

// Helper zuan request
async function zuanRequest(endpoint, method = 'GET', body = null) {
  const url = `https://apis.zxuantopup.app/v1${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': ZUAN_API_KEY
    }
  };
  if (body) options.body = JSON.stringify(body);
  const resp = await fetch(url, options);
  return resp.json();
}

// Middleware auth
function auth(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ==================== API ROUTES (untuk frontend fetch) ====================

// Register
app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  const existing = await usersDB.findUserByEmail(email);
  if (existing) return res.json({ success: false, error: 'Email sudah terdaftar' });
  const user = { email, password, name, balance: 0, apiKey: null, createdAt: new Date().toISOString() };
  await usersDB.addUser(user);
  req.session.user = { email, name };
  res.json({ success: true });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await usersDB.findUserByEmail(email);
  if (!user || user.password !== password) return res.json({ success: false, error: 'Email atau password salah' });
  req.session.user = { email: user.email, name: user.name };
  res.json({ success: true });
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Get current user
app.get('/api/me', auth, async (req, res) => {
  const user = await usersDB.findUserByEmail(req.session.user.email);
  res.json({ success: true, user: { email: user.email, name: user.name, balance: user.balance, apiKey: user.apiKey } });
});

// List games
app.get('/api/games', async (req, res) => {
  const result = await zuanRequest('/game/list');
  if (result.success) res.json(result);
  else res.status(500).json({ error: 'Gagal ambil data game' });
});

// Detail game (products)
app.get('/api/game/:slug', async (req, res) => {
  const result = await zuanRequest(`/game/${req.params.slug}/detail`);
  if (result.success) res.json(result);
  else res.status(500).json({ error: 'Gagal ambil detail' });
});

// Detail product
app.get('/api/product/:slug/:code', async (req, res) => {
  const result = await zuanRequest(`/game/${req.params.slug}/product/${req.params.code}`);
  if (result.success) res.json(result);
  else res.status(500).json({ error: 'Gagal ambil product' });
});

// Create order (butuh login)
app.post('/api/order', auth, async (req, res) => {
  const { product_code, slug, target, target_zone } = req.body;
  const user = await usersDB.findUserByEmail(req.session.user.email);
  
  // Ambil harga asli dari API
  const productDetail = await zuanRequest(`/game/${slug}/product/${product_code}`);
  if (!productDetail.success) return res.json({ success: false, error: 'Product tidak ditemukan' });
  const originalPrice = productDetail.data.price;
  const totalPrice = originalPrice + MARKUP;
  
  if (user.balance < totalPrice) return res.json({ success: false, error: 'Saldo tidak cukup' });
  
  // Panggil API Zuan untuk order
  const orderBody = { product_code, target };
  if (target_zone) orderBody.target_zone = target_zone;
  const orderResult = await zuanRequest('/game/order', 'POST', orderBody);
  if (!orderResult.success) return res.json({ success: false, error: orderResult.message });
  
  // Kurangi saldo user
  user.balance -= totalPrice;
  await usersDB.updateUser(user.email, { balance: user.balance });
  
  // Simpan transaksi ke GitHub
  const transaction = {
    id: orderResult.data.order_id,
    reference: orderResult.data.reference,
    product_code,
    product_name: orderResult.data.product_name,
    target,
    price: totalPrice,
    original_price: originalPrice,
    markup: MARKUP,
    status: orderResult.data.status,
    user_email: user.email,
    created_at: new Date().toISOString()
  };
  const allTrans = await transactionsDB.read();
  allTrans.push(transaction);
  await transactionsDB.write(allTrans);
  
  res.json({ success: true, order: orderResult.data, totalPrice });
});

// Cek status transaksi
app.post('/api/order/status', auth, async (req, res) => {
  const { trx_ref } = req.body;
  const result = await zuanRequest('/game/status', 'POST', { trx_ref });
  if (result.success) {
    // Update status di DB lokal jika perlu
    const allTrans = await transactionsDB.read();
    const idx = allTrans.findIndex(t => t.id === trx_ref);
    if (idx !== -1 && allTrans[idx].status !== result.data.status) {
      allTrans[idx].status = result.data.status;
      await transactionsDB.write(allTrans);
    }
    res.json(result);
  } else {
    res.status(500).json({ error: 'Gagal cek status' });
  }
});

// Riwayat transaksi user
app.get('/api/transactions', auth, async (req, res) => {
  const allTrans = await transactionsDB.read();
  const userTrans = allTrans.filter(t => t.user_email === req.session.user.email);
  res.json({ success: true, transactions: userTrans });
});

// Deposit via Digital Pedia (QRIS)
app.post('/api/deposit/create', auth, async (req, res) => {
  const { amount } = req.body;
  if (amount < 10000) return res.json({ success: false, error: 'Minimal deposit Rp10.000' });
  const resp = await fetch(`${DIGITALPEDIA_BASE}/deposit/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount })
  });
  const data = await resp.json();
  if (data.success) {
    // Simpan deposit pending
    const depositRecord = {
      id: data.deposit.id,
      amount: data.deposit.total_payment,
      user_email: req.session.user.email,
      status: 'pending',
      qr_image: data.deposit.qr_image,
      created_at: new Date().toISOString()
    };
    const allDeposits = await depositsDB.read();
    allDeposits.push(depositRecord);
    await depositsDB.write(allDeposits);
    res.json({ success: true, deposit: data.deposit });
  } else {
    res.json({ success: false, error: 'Gagal buat deposit' });
  }
});

// Cek status deposit dan update saldo jika sukses
app.post('/api/deposit/status', auth, async (req, res) => {
  const { deposit_id } = req.body;
  const allDeposits = await depositsDB.read();
  const deposit = allDeposits.find(d => d.id === deposit_id);
  if (!deposit) return res.json({ success: false, error: 'Deposit tidak ditemukan' });
  
  const resp = await fetch(`${DIGITALPEDIA_BASE}/deposit/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deposit_id })
  });
  const data = await resp.json();
  if (data.success && data.status === 'success' && deposit.status !== 'success') {
    // Update saldo user
    const user = await usersDB.findUserByEmail(deposit.user_email);
    user.balance += deposit.amount;
    await usersDB.updateUser(user.email, { balance: user.balance });
    // Update status deposit
    deposit.status = 'success';
    await depositsDB.write(allDeposits);
  }
  res.json(data);
});

// Join reseller (bayar 15k, dapat API key)
app.post('/api/reseller/join', auth, async (req, res) => {
  const user = await usersDB.findUserByEmail(req.session.user.email);
  const resellerPrice = 15000;
  if (user.balance < resellerPrice) return res.json({ success: false, error: 'Saldo tidak cukup' });
  
  // Generate API key
  const apiKey = crypto.randomBytes(32).toString('hex');
  user.balance -= resellerPrice;
  user.apiKey = apiKey;
  await usersDB.updateUser(user.email, { balance: user.balance, apiKey });
  
  // Simpan ke resellers.json
  const resellers = await resellersDB.read();
  resellers.push({ email: user.email, apiKey, joinedAt: new Date().toISOString() });
  await resellersDB.write(resellers);
  
  res.json({ success: true, apiKey });
});

// ==================== Serve HTML pages (fallback) ====================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));