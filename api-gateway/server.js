const express = require('express');
const http = require('http');
const prom = require('prom-client');

const app = express();

const gatewayCounter = new prom.Counter({
  name: 'gateway_requests_total',
  help: 'Total de pedidos recebidos pelo API Gateway',
  labelNames: ['method', 'endpoint', 'http_status']
});

const gatewayDuration = new prom.Histogram({
  name: 'gateway_request_duration_seconds',
  help: 'Duração dos pedidos do API Gateway em segundos',
  labelNames: ['endpoint']
});

// basically GET http://catalog:8001/events but not really
app.get('/events', (req, res) => {
  const start = performance.now();
  res.on('finish', () => {
    gatewayCounter.labels(req.method, '/events', String(res.statusCode)).inc();
    gatewayDuration.labels('/events').observe((performance.now() - start) / 1000);
  });

  const options = {
    hostname: 'catalog',
    port: 8001,
    path: '/events',
    method: 'GET'
  };
  const catalogRequest = http.request(options, catalogResponse => {
    res.writeHead(catalogResponse.statusCode, catalogResponse.headers);
    catalogResponse.pipe(res);
  });

  catalogRequest.on('error', () => {
    res.status(502).json({ error: 'Não foi possível contactar o Catalog' });
  });
  catalogRequest.end();
});

app.get('/events/:id', (req, res) => {
  const start = performance.now();
  res.on('finish', () => {
    gatewayCounter.labels(req.method, '/events/:id', String(res.statusCode)).inc();
    gatewayDuration.labels('/events/:id').observe((performance.now() - start) / 1000);
  });

  const options = {
    hostname: 'catalog',
    port: 8001,
    path: '/events/' + encodeURIComponent(req.params.id),
    method: 'GET'
  };
  const catalogRequest = http.request(options, catalogResponse => {
    res.writeHead(catalogResponse.statusCode, catalogResponse.headers);
    catalogResponse.pipe(res);
  });

  catalogRequest.on('error', () => {
    res.status(502).json({ error: 'Não foi possível contactar o Catalog' });
  });
  catalogRequest.end();
});

app.post('/orders', (req, res) => {
  const start = performance.now();
  res.on('finish', () => {
    gatewayCounter.labels(req.method, '/orders', String(res.statusCode)).inc();
    gatewayDuration.labels('/orders').observe((performance.now() - start) / 1000);
  });

  const options = {
    hostname: 'order',
    port: 8002,
    path: '/orders',
    method: 'POST',
    headers: {
      'Content-Type': req.headers['content-type'] || 'application/json'
    }
  };
  const orderRequest = http.request(options, orderResponse => {
    res.writeHead(orderResponse.statusCode, orderResponse.headers);
    orderResponse.pipe(res);
  });

  orderRequest.on('error', () => {
    res.status(502).json({ error: 'Não foi possível contactar o Order' });
  });
  req.pipe(orderRequest);
});


app.get('/orders/:id', (req, res) => {
  const start = performance.now();
  res.on('finish', () => {
    gatewayCounter.labels(req.method, '/orders/:id', String(res.statusCode)).inc();
    gatewayDuration.labels('/orders/:id').observe((performance.now() - start) / 1000);
  });

  const options = {
    hostname: 'order',
    port: 8002,
    path: '/orders/' + encodeURIComponent(req.params.id),
    method: 'GET'
  };
  const orderRequest = http.request(options, orderResponse => {
    res.writeHead(orderResponse.statusCode, orderResponse.headers);
    orderResponse.pipe(res);
  });

  orderRequest.on('error', () => {
    res.status(502).json({ error: 'Não foi possível contactar o Order' });
  });
  orderRequest.end();
});


app.get('/metrics', async (req, res) => {
  res.end(await prom.register.metrics());
});

app.listen(8000, () => {
  console.log('API Gateway a correr na porta 8000');
});
