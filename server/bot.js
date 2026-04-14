// CRYPTO ROULETTE — Telegram Bot for /buy command
// Запуск: node bot.js
// Работает параллельно с server.js

const BOT_TOKEN = '8426341625:AAEgRnYhk9pYVSosTudAMJ8Sb67t8etFJEg';
const OWNER_USERNAME = 'lagaet'; // без @
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

const https = require('https');
const http = require('http');

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Telegram API helpers ──
function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${TG_API}/${method}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch (e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sendMessage(chatId, text, parseMode) {
  return tgRequest('sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: parseMode || 'HTML'
  });
}

// ── Server API call ──
function buyRequest(username, amount) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ owner: OWNER_USERNAME, username: username, amount: amount });
    const url = new URL(`${SERVER_URL}/api/buy`);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = lib.request(options, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch (e) { reject(new Error('Bad response')); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Polling ──
let offset = 0;

async function poll() {
  try {
    const res = await tgRequest('getUpdates', { offset: offset, timeout: 30 });
    if (res.ok && res.result) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        if (update.message && update.message.text) {
          await handleMessage(update.message);
        }
      }
    }
  } catch (e) {
    console.error('Poll error:', e.message);
    await new Promise(r => setTimeout(r, 3000));
  }
  poll(); // loop
}

async function handleMessage(msg) {
  const text = msg.text.trim();
  const from = msg.from;
  const chatId = msg.chat.id;
  const username = (from.username || '').toLowerCase();

  // /start
  if (text === '/start') {
    await sendMessage(chatId, '🎰 <b>Crypto Roulette Bot</b>\n\nИспользуйте Mini App для игры!');
    return;
  }

  // /buy command — owner only
  if (text.startsWith('/buy')) {
    // Check owner
    if (username !== OWNER_USERNAME) {
      await sendMessage(chatId, '⛔ Эта команда доступна только владельцу.');
      return;
    }

    // Parse: /buy 500 @username
    const parts = text.split(/\s+/);
    if (parts.length < 3) {
      await sendMessage(chatId, '📝 Формат: <code>/buy [сумма] @username</code>\n\nПример: <code>/buy 500 @player123</code>');
      return;
    }

    const amount = parseFloat(parts[1]);
    let targetUser = parts[2].replace(/^@/, '');

    if (isNaN(amount) || amount <= 0) {
      await sendMessage(chatId, '❌ Неверная сумма.');
      return;
    }

    if (!targetUser) {
      await sendMessage(chatId, '❌ Укажите @username.');
      return;
    }

    try {
      const result = await buyRequest(targetUser, amount);

      if (result.ok) {
        // Ответ с анимированными эмодзи
        // customEmojiId для animated emoji
        const response = `<tg-emoji emoji-id="5427009714745517609">💰</tg-emoji> Баланс @${targetUser} пополнен на <b>${amount}</b> TON <tg-emoji emoji-id="5377620962390857342">✅</tg-emoji>\n\nНовый баланс: <b>${result.balance}</b> TON`;
        await sendMessage(chatId, response);
        console.log(`[BUY] @${targetUser} +${amount} TON = ${result.balance} TON`);
      } else {
        await sendMessage(chatId, `❌ Ошибка: ${result.error || 'Неизвестная ошибка'}`);
      }
    } catch (e) {
      await sendMessage(chatId, `❌ Сервер недоступен: ${e.message}`);
      console.error('Buy error:', e.message);
    }
    return;
  }

  // /balance @username — check balance (owner only)
  if (text.startsWith('/balance')) {
    if (username !== OWNER_USERNAME) {
      await sendMessage(chatId, '⛔ Эта команда доступна только владельцу.');
      return;
    }
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendMessage(chatId, '📝 Формат: <code>/balance @username</code>');
      return;
    }
    const targetUser = parts[1].replace(/^@/, '');
    // We'd need a GET endpoint for this, but for now just inform
    await sendMessage(chatId, `ℹ️ Баланс @${targetUser} можно посмотреть в логах сервера.`);
    return;
  }
}

// ── Start ──
console.log('🤖 Roulette Bot starting...');
console.log(`👤 Owner: @${OWNER_USERNAME}`);
console.log(`🌐 Server: ${SERVER_URL}`);
console.log('');

// Set bot commands
tgRequest('setMyCommands', {
  commands: [
    { command: 'start', description: 'Запустить бота' },
    { command: 'buy', description: 'Пополнить баланс (владелец)' },
  ]
}).then(() => {
  console.log('✅ Commands set');
  poll();
}).catch(e => {
  console.error('Failed to set commands:', e.message);
  poll();
});
