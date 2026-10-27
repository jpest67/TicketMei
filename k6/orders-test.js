import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ['rate==1'],
  },
};

function notificacoesEnviadas() {
  const resposta = http.get('http://notification:8003/metrics');
  if (resposta.status !== 200) {
    throw new Error('Não foi possível consultar as métricas do Notification');
  }
  const contador = resposta.body.match(/^notifications_processed_total\{status="SENT"\} (\d+)/m);
  return contador ? Number(contador[1]) : 0;
}

export default function () {
  const antes = notificacoesEnviadas();
  const dados = {
    customer_id: 'teste-k6',
    event_id: 'evt-101',
    quantity: 2,
    email: 'teste-k6@example.com',
  };
  const parametros = { headers: { 'Content-Type': 'application/json' } };
  const resposta = http.post('http://api-gateway:8000/orders', JSON.stringify(dados), parametros);

  check(resposta, { 'POST /orders devolve 202': r => r.status === 202 });
  if (resposta.status !== 202) {
    console.error(resposta.body);
    return;
  }

  const compra = resposta.json();
  check(compra, {
    'compra fica PENDING': c => c.status === 'PENDING',
    'total de dois bilhetes é 170 euros': c => c.total_amount === 170,
  });

  const consulta = http.get('http://api-gateway:8000/orders/' + compra.id);
  check(consulta, {
    'GET /orders/:id devolve a compra guardada': r =>
      r.status === 200 && r.json().id === compra.id &&
      r.json().quantity === 2 && r.json().status === 'PENDING',
  });

  let depois = antes;
  for (let tentativa = 0; tentativa < 30 && depois <= antes; tentativa++) {
    sleep(0.5);
    depois = notificacoesEnviadas();
  }
  check(depois, { 'Notification processou uma nova mensagem': valor => valor > antes });
}
