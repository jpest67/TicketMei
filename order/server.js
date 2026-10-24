const express = require('express');
// library used to allow order to communicate with rabbitmq through AMQP
const amqp = require('amqplib');
const prom = require('prom-client');
//database related
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const app = express();
//client JSON data inside request -> req.body.
app.use(express.json());

const ordersCounter = new prom.Counter({
  name: 'orders_initiated_total',
  help: 'Compras iniciadas e transições para falha de publicação',
  labelNames: ['status']
});

//node:sqlite  ORDER DATABASE
const dataFolder = join(__dirname, 'data');
mkdirSync(dataFolder, { recursive: true });
const db = new DatabaseSync(join(dataFolder, 'orders.db'));

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

//DATA NOT OK = TRUE    DATA OK = NULL
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
// REMINDER TO IMPLEMENT "EMAIL CHECKER" LATER - [THIS IS FOR NOTIFICATION]
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


//publishes purchase to RabbitMQ
async function publicarCompra(compra) {
  //connect RabbitMQ
  const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672';
  const ligacao = await amqp.connect(rabbitUrl);
  ligacao.on('error', erro => console.error('Erro na ligação ao RabbitMQ:', erro.message));

  try {
    //Open Channel -> canal
    const canal = await ligacao.createConfirmChannel();
    canal.on('error', erro => console.error('Erro no canal RabbitMQ:', erro.message));

    //Does Queue exist -> fila
    const fila = 'order_created';
    await canal.assertQueue(fila, { durable: true });

    //message
    const mensagem = {
      type: 'OrderCreated',
      order_id: compra.id,
      email: compra.email
    };
    // send message
    canal.sendToQueue(
      fila,
      Buffer.from(JSON.stringify(mensagem)),
      { persistent: true }
    );
    // wait for confirmation from RabbitMQ
    await canal.waitForConfirms();
  } finally {
    await ligacao.close();
  }
}

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
  res.status(202).json(compra);
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
  res.end(await prom.register.metrics());
});

app.listen(8002, () => {
  console.log('Order a correr na porta 8002');
});
