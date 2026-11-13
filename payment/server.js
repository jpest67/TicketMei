const express = require('express');

const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const app = express();
app.use(express.json());

//node:sqlite  ORDER DATABASE
const dataFolder = join(__dirname, 'data');
mkdirSync(dataFolder, { recursive: true });
const db = new DatabaseSync(join(dataFolder, 'payments.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE,
    amount REAL NOT NULL, 
    status TEXT NOT NULL CHECK (status IN ('SUCCESS','FAILED')),
    processed_at TEXT NOT NULL
  )
`);

const findPayment = db.prepare('SELECT * FROM payments WHERE order_id = ?');
const insertPayment = db.prepare(`
  INSERT INTO payments (order_id, amount, status, processed_at)
  VALUES (?, ?, 'SUCCESS', ?)
  RETURNING *
`);

app.post('/payments', (req, res) => {
  const { order_id: orderId, amount } = req.body ?? {}; //use the request body if it exists, otherwise use an empty object.

  if (typeof orderId !== 'string' || !orderId.trim()) {
    return res.status(400).json({ error: 'order_id is required' });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const existing = findPayment.get(orderId); //if same order comes multiple times
  if (existing) { //does this need some fail message? because you can just return what's already in...
    return res.status(200).json(existing);
  }

  const payment = insertPayment.get(orderId, amount, new Date().toISOString());
  return res.status(201).json(payment);
});

app.listen(8004, () => {
  console.log('Payment is listening on port 8004');
});







//POST /payments
//read order_id and amount -- nonempty positive number //the db might need to specify alot more stuff
//save payment with a generated id, the respective order_id, price amount, set status to success, and a timestamp processed_at
// return 201 with saved payment, PORT 8004 for local service

/*
 Invoke-WebRequest -UseBasicParsing http://localhost:8004/payments `
  -Method Post `
  -ContentType 'application/json' `
  -Body '{"order_id":"test-order-2","amount":170}' |
  Select-Object StatusCode, Content
*/