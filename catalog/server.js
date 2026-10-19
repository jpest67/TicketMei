//express - biblioteca - receber e enviar requests.
const express = require('express');
//prom-client (prom = prometheus?) - métricas
const prom = require('prom-client');
const events = require('./data/events.json');

const app = express();

// counter - in each res we add respective labels().inc()
const catalogCounter = new prom.Counter({
  name: 'catalog_requests_total',
  help: 'Total de pedidos recebidos pelo Catalog',
  labelNames: ['endpoint', 'http_status']
});

// histograma recieves measurements (of time buckets, sum and count)
const catalogDuration = new prom.Histogram({
  name: 'catalog_request_duration_seconds',
  help: 'Duration dos pedidos do Catalog em segundos'
});

//get /events 
app.get('/events', (req, res) => {
  const start = performance.now();
  res.on('finish', () => {
    catalogDuration.observe((performance.now() - start) / 1000);
  });

  catalogCounter.labels('/events', '200').inc();
  res.json(events);
});

//get /event/{id}
app.get('/events/:id', (req, res) => {
  const start = performance.now();
  res.on('finish', () => {
    catalogDuration.observe((performance.now() - start) / 1000);
  });

  // find runs the list until condition is met and returns the object that fits
  const event = events.find(event => event.id === req.params.id);
  if (!event) {
    catalogCounter.labels('/events/:id', '404').inc();
    return res.status(404).json({ error: 'Evento não encontrado' });
  }
  
  catalogCounter.labels('/events/:id', '200').inc();
  res.json(event);
});

//GET /metrics
app.get('/metrics', async (req, res) => {
  res.end(await prom.register.metrics());
});

//receber pedidos na porta 8001 
app.listen(8001, () => {
  console.log('Catalog a correr na porta 8001');
});
