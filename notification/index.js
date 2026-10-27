const express = require('express');
const amqp = require('amqplib');
const client = require('prom-client');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 8003;

//create file and function to save notif - probably should bring data out of catalog in future idk
const dataFolder = path.join(__dirname, 'data');
fs.mkdirSync(dataFolder, { recursive: true });
const logFile = path.join(dataFolder, 'notification_logs.json');
if (!fs.existsSync(logFile)) {
  fs.writeFileSync(logFile, '[]');
}

function guardarNotificacao(notificacao) {
  const registos = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  registos.push(notificacao);
  fs.writeFileSync(logFile, JSON.stringify(registos, null, 2));
}


const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();

const notificationsProcessedTotal = new client.Counter({
  name: 'notifications_processed_total',
  help: 'Total notifications processed',
  labelNames: ['status']
});

const notificationProcessingDuration = new client.Histogram({
  name: 'notification_processing_duration_seconds',
  help: 'Duration of notification processing in seconds'
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

async function connectRabbitMQ() {
  try {
    const connection = await amqp.connect('amqp://rabbitmq:5672');
    const channel = await connection.createChannel();
    const queue = 'order_created';

    await channel.assertQueue(queue, { durable: true });
    console.log("Waiting for messages in queue:", queue);

    channel.consume(queue, (msg) => {
      if (msg !== null) {
        const end = notificationProcessingDuration.startTimer();
        const orderData = JSON.parse(msg.content.toString());

        //actually saving it
        setTimeout(() => {
          try {
            const notificacao = {
              Order_id: orderData.order_id,
              Email: orderData.email,
              Status: "SENT"
            };
            guardarNotificacao(notificacao);
            console.log(JSON.stringify(notificacao));
            notificationsProcessedTotal.inc({ status: 'SENT' });
            channel.ack(msg);
          } catch (error) {
            console.error('Erro ao registar a notificação:', error.message);
            notificationsProcessedTotal.inc({ status: 'FAILED' });
            channel.nack(msg, false, false);
          } finally {
            end();
          }
        }, 100);
      }
    });
  } catch (error) {
    console.error("Connection error, retrying in 5 seconds...", error.message);
    setTimeout(connectRabbitMQ, 5000);
  }
}

app.listen(port, () => {
  console.log(`Notification service is listening on port ${port}`);
  connectRabbitMQ();
});
