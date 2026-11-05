import http from 'k6/http';
import { check, sleep } from 'k6';

const gatewayUrl = __ENV.GATEWAY_URL || 'http://api-gateway:8000';

export const options = {
  stages: [
    { duration: '3m', target: 500 }, // Ramp-up to 500 Virtual Users over 3 minutes
    { duration: '2m', target: 500 }, // Sustain 500 Virtual Users for 2 minutes
    { duration: '30s', target: 0 },  // Scale down
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'], // 95% of requests must complete below 200ms
    http_req_failed: ['rate<0.01'],   // Less than 1% failed requests
  },
};
//what load-test does
export default function () {
  const res = http.get(gatewayUrl + '/events');
  check(res, {
    'GET /events devolve 200': r => r.status === 200,
  });

  const evento = http.get(gatewayUrl + '/events/evt-101');
  check(evento, {
    'GET /events/:id devolve 200': r => r.status === 200,
  });
  sleep(0.1);
}
