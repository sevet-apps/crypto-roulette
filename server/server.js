// бот + апи баланса для арены
// токен НЕ хардкодим, берём из переменной окружения BOT_TOKEN

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('Нет BOT_TOKEN в переменных окружения, выходим');
  process.exit(1);
}

const OWNER_ID = 1482228376;      // @lagaet
const OWNER_USERNAME = 'lagaet';

// айди кастомных эмодзи для ответа на /buy
const EMOJI_LEFT = '5427009714745517609';
const EMOJI_RIGHT = '5377620962390857342';

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

// простая файловая хранилка балансов, потом переедет в supabase
const DB_FILE = path.join(__dirname, 'balances.json');
let balances = {};
try { balances = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}

function saveBalances() {
  fs.writeFileSync(DB_FILE, JSON.stringify(balances, null, 2));
}

function isOwner(msg) {
  return msg.from && (msg.from.id === OWNER_ID ||
    (msg.from.username || '').toLowerCase() === OWNER_USERNAME);
}

// /buy 50 @username — пополнить баланс юзера, только для владельца
bot.onText(/^\/buy\s+([\d.,]+)\s+@?(\w+)/i, (msg, match) => {
  if (!isOwner(msg)) return; // молча игнорим чужих

  const amount = parseFloat(match[1].replace(',', '.'));
  const username = match[2].toLowerCase();

  if (!amount || amount <= 0) {
    bot.sendMessage(msg.chat.id, 'Сумма не понята, пример: /buy 50 @username');
    return;
  }

  balances[username] = +((balances[username] || 0) + amount).toFixed(2);
  saveBalances();

  // собираем текст с кастомными эмодзи по краям
  // 💎 — плейсхолдер, телега заменит его на премиум-эмодзи по custom_emoji_id
  const ph = '💎';
  const body = ` Баланс @${username} пополнен на ${amount} `;
  const text = ph + body + ph;

  bot.sendMessage(msg.chat.id, text, {
    entities: [
      { type: 'custom_emoji', offset: 0, length: ph.length, custom_emoji_id: EMOJI_LEFT },
      { type: 'custom_emoji', offset: text.length - ph.length, length: ph.length, custom_emoji_id: EMOJI_RIGHT },
    ],
  }).catch(() => {
    // кастомные эмодзи в сообщениях бота работают только если у бота
    // куплен коллекционный юзернейм на Fragment, иначе шлём обычный текст
    bot.sendMessage(msg.chat.id, `Баланс @${username} пополнен на ${amount}`);
  });
});

// баланс можно глянуть и в личке у бота
bot.onText(/^\/balance/, (msg) => {
  const u = (msg.from.username || '').toLowerCase();
  const b = balances[u] || 0;
  bot.sendMessage(msg.chat.id, `Твой баланс: ${b} TON`);
});

// ---- api для фронта ----

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
});

app.get('/api/balance/:username', (req, res) => {
  const u = req.params.username.toLowerCase().replace('@', '');
  res.json({ username: u, balance: balances[u] || 0 });
});

app.get('/', (req, res) => res.send('arena api ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('api на порту', PORT));
