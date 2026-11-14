const express = require('express');
const prom = require('prom-client');

const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const app = express();
app.use(express.json());

const paymentRequests = new prom.Counter({
  name: 'payment_requests_total',
  help: 'Payment requests by HTTP status',
  labelNames: ['http_status']
});

const paymentDuration = new prom.Histogram({
  name: 'payment_processing_duration_seconds',
  help: 'Time spent handling a payment request in seconds'
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', prom.register.contentType);
  res.end(await prom.register.metrics());
});


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

let delayMs = 0;
let errorRate = 0;

app.post('/payments/configure-faults', (req, res) => {
  const newDelay = req.body?.delayMs ?? delayMs;
  const newErrorRate = req.body?.errorRate ?? errorRate;
  if (!Number.isInteger(newDelay) || newDelay < 0) {
    return res.status(400).json({ error: 'delayMs must be a non-negative integer' });
  }
  if (!Number.isFinite(newErrorRate) || newErrorRate < 0 || newErrorRate > 100) {
    return res.status(400).json({ error: 'errorRate must be between 0 and 100' });
  }
  delayMs = newDelay;
  errorRate = newErrorRate;
  return res.status(200).json({ delayMs, errorRate });
});

app.post('/payments', async (req, res) => {
  const stopTimer = paymentDuration.startTimer();
  res.on('finish', () => {
    paymentRequests.labels(String(res.statusCode)).inc();
    stopTimer();
  });
  const { order_id: orderId, amount } = req.body ?? {}; //use the request body if it exists, otherwise use an empty object.

  if (typeof orderId !== 'string' || !orderId.trim()) {
    return res.status(400).json({ error: 'order_id is required' });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  const existing = findPayment.get(orderId); //if same order comes multiple times
  if (existing) { //does this need some fail message? because you can just return what's already in...
    return res.status(200).json(existing);
  }

  if (Math.random() * 100 < errorRate) {
    return res.status(500).json({ error: 'Simulated payment failure' });
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

/* SET THE DELAY
Invoke-RestMethod http://localhost:8004/payments/configure-faults `
  -Method Post -ContentType 'application/json' -Body '{"delayMs":2000}'
*/
/* TEST STATUS CODE + DELAY 
$time = Measure-Command {
  $response = Invoke-WebRequest -UseBasicParsing http://localhost:8004/payments `
    -Method Post -ContentType 'application/json' `
    -Body '{"order_id":"test-delay-1","amount":170}'
}
$response.StatusCode
$time.TotalSeconds
*/