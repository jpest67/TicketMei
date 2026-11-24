import http from 'k6/http';
import { check } from 'k6';

const gatewayUrl = __ENV.GATEWAY_URL || 'http://api-gateway:8000';

export const options = {
  noConnectionReuse: true,
  scenarios: {
    orders: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: __ENV.DURATION || '6m',
      preAllocatedVUs: 300,
      maxVUs: 300
    }
  },
  thresholds: {
    checks: ['rate==1'],
    dropped_iterations: ['count==0']
  }
};

export default function () {
  const response = http.post(
    gatewayUrl + '/orders',
    JSON.stringify({
      customer_id: 'teste-k6-' + __VU,
      event_id: 'evt-101',
      quantity: 2,
      email: 'teste-k6@example.com'
    }),
    {
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'k6-resilience' },
      responseCallback: http.expectedStatuses(201, 502, 503)
    }
  );

  check(response, {
    'checkout returns success or payment failure': r =>
      __ENV.HEALTHY_ONLY === 'true' ? r.status === 201 : [201, 502, 503].includes(r.status)
  });
}

