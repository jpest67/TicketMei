import http from 'k6/http';
import { check, sleep } from 'k6';

const gatewayUrl = __ENV.GATEWAY_URL || 'http://api-gateway:8000';
const respostasEsperadas = http.expectedStatuses(202, 429);

export const options = {
  stages: [
    { duration: '3m', target: 500 }, // Ramp-up to 500 Virtual Users over 3 minutes
    { duration: '2m', target: 500 }, // Sustain 500 Virtual Users for 2 minutes
    { duration: '30s', target: 0 },  // Scale down
  ],
  thresholds: {
    //realistic p95 here? http_req_duration: ['p(95)<200'], // 95% of requests must complete below 200ms
    http_req_failed: ['rate<0.01'],   // Less than 1% failed requests
  },
};

export default function () {
  const dados = {
    customer_id: 'teste-k6-' + __VU, //virtual user
    event_id: 'evt-101', //future tests we should explore making this random
    quantity: 2, // same thing here
    email: 'teste-k6@example.com', // and here
  };

  const res = http.post(
    gatewayUrl + '/orders',
    JSON.stringify(dados), //convert to json so it can be snet over http
    {
      headers: { 'Content-Type': 'application/json' },
      responseCallback: respostasEsperadas,
    }
  );

  if (res.status === 202) {
    check(res, {
      'POST /orders aceita a compra com 202': r => r.status === 202,
    });
    const compra = res.json();
    const consulta = http.get(gatewayUrl + '/orders/' + compra.id);
    check(consulta, {
      'GET /orders/:id devolve 200': r => r.status === 200,
    });
  } else {
    check(res, {
      'POST /orders rejeita o excesso com 429': r => r.status === 429,
    });
  }
  sleep(0.1);
}
// POST /orders e GET /orders/:id - até 500 utilizadores virtuais.
// docker compose run --rm --no-deps k6 run -e GATEWAY_URL=http://host.docker.internal:30000 load-orders.js

// docker compose run --rm --no-deps k6 run -e GATEWAY_URL=http://host.docker.internal:30000 --stage '10s:2,30s:2,5s:0' load-orders.js