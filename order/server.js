const express = require('express');
// library used to allow order to communicate with rabbitmq through AMQP
const amqp = require('amqplib');
const prom = require('prom-client');
const CircuitBreaker = require('opossum');
//database related
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const app = express();
//client JSON data inside request -> req.body.
app.use(express.json());

// --- PROMETHEUS METRICS FOR PHASE 1 ---
const ordersCounter = new prom.Counter({
  name: 'orders_initiated_total',
  help: 'Compras iniciadas e transições para falha de publicação',
  labelNames: ['status']
});

const cbStateGauge = new prom.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit Breaker State: 0={Closed}, 1={Open}, 2={Half-Open}'
});
cbStateGauge.set(0); // initial state CLOSED

const cbFallbacksTotal = new prom.Counter({
  name: 'circuit_breaker_fallbacks_total',
  help: 'Total number of Circuit Breaker fallbacks executed'
});

const paymentRequestsTotal = new prom.Counter({
  name: 'payment_client_requests_total',
  help: 'Total payment client requests',
  labelNames: ['status']
});

//node:sqlite  ORDER DATABASE
const dataFolder = join(__dirname, 'data');
mkdirSync(dataFolder, { recursive: true });
const db = new DatabaseSync(join(dataFolder, 'orders.db'));
// Enable WAL only on local storage, not the global NFS volume.
if (process.env.SQLITE_WAL === 'true') {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY NOT NULL,
    customer_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total_amount REAL NOT NULL,
    status TEXT NOT NULL,
    email TEXT NOT NULL
  )
`);

//DATA NOT OK = TRUE    DATA OK = NULL  RF2
function validarCompra(dados) {
  if (!dados) {
    return 'É necessário enviar os dados da compra';
  }
  //must be text and not empty
  if (typeof dados.customer_id !== 'string' || dados.customer_id.trim() === '') {
    return 'customer_id é obrigatório e deve ser texto';
  }

  if (typeof dados.event_id !== 'string' || dados.event_id.trim() === '') {
    return 'event_id é obrigatório e deve ser texto';
  }
  //enunciado 
  if (!Number.isInteger(dados.quantity) || dados.quantity < 1 || dados.quantity > 4) {
    return 'quantity deve ser um número inteiro entre 1 e 4';
  }
// REMINDER TO IMPLEMENT BETTER "EMAIL CHECKER" LATER IF NEEDED - [THIS IS FOR NOTIFICATION]
  if (typeof dados.email !== 'string' || dados.email.trim() === '') {
    return 'email é obrigatório e deve ser texto';
  }
  return null;
}

//"GET" EVENTS from CATALOG
async function obterEvento(eventId) {
  const resposta = await fetch('http://catalog:8001/events/' + encodeURIComponent(eventId));

  if (resposta.status === 404) {
    return null;
  }

  if (!resposta.ok) {
    throw new Error('Não foi possível consultar o Catalog');
  }

  return await resposta.json();
}

// updates de DB - adds a new value
function guardarCompra(dados, evento) {
  const compra = {
    id: randomUUID(),//not just the number 4. - does this need to check if ID already exists? how random is random?
    customer_id: dados.customer_id,
    event_id: evento.id,
    created_at: new Date().toISOString(),
    quantity: dados.quantity,
    total_amount: Math.round(evento.price_eur * 100) * dados.quantity / 100,
    status: 'PENDING',
    email: dados.email
  };

  const inserir = db.prepare(`
    INSERT INTO orders (
      id, customer_id, event_id, created_at,
      quantity, total_amount, status, email
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  inserir.run(
    compra.id, compra.customer_id, compra.event_id, compra.created_at,
    compra.quantity, compra.total_amount, compra.status, compra.email
  );

  ordersCounter.labels('PENDING').inc();
  return compra;
}

let rabbitChannelPromise = null;

async function getRabbitChannel() {
  if (!rabbitChannelPromise) {
    rabbitChannelPromise = (async () => {
      const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';
      const ligacao = await amqp.connect(rabbitUrl);
      ligacao.on('error', erro => {
        console.error('Erro na ligação ao RabbitMQ:', erro.message);
        rabbitChannelPromise = null;
      });
      ligacao.on('close', () => {
        rabbitChannelPromise = null;
      });

      const canal = await ligacao.createConfirmChannel();
      canal.on('error', erro => {
        console.error('Erro no canal RabbitMQ:', erro.message);
        rabbitChannelPromise = null;
      });

      const fila = 'order_created';
      await canal.assertQueue(fila, { durable: true });
      await canal.assertExchange('orders.exchange', 'direct', { durable: true });
      await canal.bindQueue(fila, 'orders.exchange', 'OrderCreated');
      return canal;
    })().catch(err => {
      rabbitChannelPromise = null;
      throw err;
    });
  }
  return rabbitChannelPromise;
}

async function publicarCompra(compra) {
  const canal = await getRabbitChannel();
  const mensagem = {
    type: 'OrderCreated',
    order_id: compra.id,
    email: compra.email
  };
  canal.publish(
    'orders.exchange',
    'OrderCreated',
    Buffer.from(JSON.stringify(mensagem)),
    { persistent: true }
  );
  await canal.waitForConfirms();
}

// --- PAYMENT FUNCTION FOR CIRCUIT BREAKER ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function makePaymentCall(compra) {
  // Try up to 3 times (1 initial + 2 retries with jitter) before throwing error to CB
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    if (paymentBreaker.opened) {          //need to stop retries
      throw new Error('Circuit is open');
    }
    attempt++;
    try {
      const resposta = await fetch('http://payment:8004/payments', {
        method: 'POST',
        signal: AbortSignal.timeout(1500),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_id: compra.id,
          amount: compra.total_amount
        })
      });

      if (resposta.ok) {
        paymentRequestsTotal.labels('2xx').inc();
        return true;
      } else {
        paymentRequestsTotal.labels(resposta.status.toString()).inc();
        throw new Error('Payment failed'); 
      }
    } catch (erro) {
      if (erro.name === 'TimeoutError') {
         paymentRequestsTotal.labels('timeout').inc();
      } else if (erro.message !== 'Payment failed') {
      paymentRequestsTotal.labels('network_error').inc();
      }
// 500 responses were being counted as timeouts
      if (attempt >= maxAttempts || paymentBreaker.opened) {
        throw erro;
      }
      // Jitter: random delay between 100ms and 500ms
      const jitter = Math.floor(Math.random() * 400) + 100;
      await sleep(jitter);
    }
  }
}

// --- OPOSSUM CIRCUIT BREAKER CONFIGURATION ---
const breakerOptions = {
  timeout: false, // -- each fetch has it's own 1500 milisecond timeout
  errorThresholdPercentage: 50, // When 50% of requests fail, open the circuit
  resetTimeout: 10000 // After 10 seconds, try to semi-open the circuit
};

const paymentBreaker = new CircuitBreaker(makePaymentCall, breakerOptions);

// Update Prometheus Gauge on state changes
paymentBreaker.on('close', () => cbStateGauge.set(0));
paymentBreaker.on('open', () => cbStateGauge.set(1));
paymentBreaker.on('halfOpen', () => cbStateGauge.set(2));

// Track fallbacks
paymentBreaker.fallback((compra, error) => {
  cbFallbacksTotal.inc();
  // Return a specific object so we know fallback was triggered
  return { fallback: true, message: error.message }; 
});

// validarCompra -> obterEvento -> guardarCompra -> publicarCompra -> respond to client
app.post('/orders', async (req, res) => {
  //validation
  const erro = validarCompra(req.body);
  if (erro) {
    return res.status(400).json({ error: erro });
  }
  //get info from catalog
  let evento;
  try {
    evento = await obterEvento(req.body.event_id);
  } catch (erro) {
    console.error('Erro ao consultar o Catalog:', erro.message);
    return res.status(502).json({ error: 'Não foi possível consultar o Catalog' });
  }

  if (!evento) {
    return res.status(404).json({ error: 'Evento não encontrado' });
  }

  // saves order
  let compra;
  try {
    compra = guardarCompra(req.body, evento);
  } catch (erro) {
    console.error('Erro ao guardar a compra:', erro.message);
    return res.status(500).json({ error: 'Não foi possível guardar a compra' });
  }

  //call payment using Opossum Circuit Breaker
  try {
    const paymentResult = await paymentBreaker.fire(compra);
    
    // Check if fallback was returned (meaning circuit is open or call failed)
    if (paymentResult && paymentResult.fallback) {
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('FAILED', compra.id);
      ordersCounter.labels('FAILED').inc();
      
      // Fast failure if circuit is OPEN
      if (paymentBreaker.opened) {
         return res.status(503).json({ error: "Payment system unavailable, try again later" });
      }
      return res.status(502).json({ error: 'Payment failed' });
    }
  } catch (erro) {
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('FAILED', compra.id);
    return res.status(502).json({ error: 'Payment failed' });
  }

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('CONFIRMED', compra.id);
  compra.status = 'CONFIRMED';
  ordersCounter.labels('CONFIRMED').inc();

  //publishes order
  try {
    await publicarCompra(compra);
  } catch (erro) {
    console.error('Erro ao publicar a compra:', erro.message);
    try {
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('FAILED', compra.id);
      ordersCounter.labels('FAILED').inc();
    } catch (erro) {
      console.error('Erro ao atualizar o estado da compra:', erro.message);
    }
    return res.status(503).json({
      error: 'Não foi possível confirmar a publicação da compra no RabbitMQ',
      order_id: compra.id
    });
  }

  //respond to client
  res.status(201).json(compra);
});

// gets values from DB
app.get('/orders/:id', (req, res) => {
  const compra = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);

  if (!compra) {
    return res.status(404).json({ error: 'Compra não encontrada' });
  }

  res.json(compra);
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', prom.register.contentType);
  res.end(await prom.register.metrics());
});

app.listen(8002, () => {
  console.log('Order a correr na porta 8002');
});