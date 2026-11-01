import http from 'k6/http';
import { check, sleep } from 'k6';

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
    'http://api-gateway:8000/orders',
    JSON.stringify(dados), //convert to json so it can be snet over http
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'POST /orders' },
    }// informs server that the data contains json and tags it for metrics requests
  );

  check(res, {
    'POST /orders devolve 202': r => r.status === 202,
  });//true or false
  sleep(0.1);
}
// docker compose run --rm k6 run --quiet load-orders.js
