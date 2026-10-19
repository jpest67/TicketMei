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

app.get('/metrics', async (req, res) => {
  res.end(await prom.register.metrics());
});

app.listen(8000, () => {
  console.log('API Gateway a correr na porta 8000');
});
