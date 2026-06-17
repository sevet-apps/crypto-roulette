// арена: бот + онлайн-сервер раундов (Socket.IO)
// токен берём из переменной окружения BOT_TOKEN (НЕ хардкодим)

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('Нет BOT_TOKEN в переменных окружения, выходим'); process.exit(1); }

const OWNER_ID = 1482228376;          // @lagaet
const OWNER_USERNAME = 'lagaet';
const EMOJI_LEFT = '5427009714745517609';
const EMOJI_RIGHT = '5377620962390857342';

const COMMISSION = 0.15;
const MIN_BET = 0.1;
const FS = 1000;
const DT = 1/60;
const BETTING_MS = 20000;
const RESOLVE_MS = 17000;             // время на анимацию+окно победы у клиента
const DEPOSIT_DAILY_LIMIT = 1000;

const bot = new TelegramBot(TOKEN, { polling: true });

// ссылка на апку для инлайн-карточки статистики
const APP_LINK = 'https://t.me/AntiCasinoBot';
const APP_NAME = 'Anticasino';
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---- хранилище: Supabase (постоянное) с фолбэком на файлы ----
// если заданы SUPABASE_URL и SUPABASE_KEY — данные переживают рестарты/деплои Render.
// иначе используется локальный файл (на бесплатном Render он стирается при рестарте).
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
let supa = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supa = createClient(SUPABASE_URL, SUPABASE_KEY, { auth:{ persistSession:false } });
    console.log('Supabase подключён — данные постоянные');
  } catch(e){ console.error('Supabase не загрузился, работаем на файлах:', e.message); }
}

// одна строка с состоянием игры (id=1): { game_id }
let gameCounter = 0;

// ---- балансы ----
const DB_FILE = path.join(__dirname, 'balances.json');
let balances = {};
function saveBalancesFile(){ try{ fs.writeFileSync(DB_FILE, JSON.stringify(balances,null,2)); }catch(e){} }
function getBalance(u){ return balances[u] || 0; }
function setBalance(u,v){
  balances[u] = +(+v).toFixed(2);
  if(supa){ supa.from('balances').upsert({ username:u, balance:balances[u] }).then(()=>{},()=>{}); }
  else saveBalancesFile();
}

const depToday = {};                  // {username: {date, sum}}
function depLeft(u){
  const today = new Date().toISOString().slice(0,10);
  const d = depToday[u];
  const used = (d && d.date===today) ? d.sum : 0;
  return Math.max(0, DEPOSIT_DAILY_LIMIT - used);
}
function addDep(u, amt){
  const today = new Date().toISOString().slice(0,10);
  if(!depToday[u] || depToday[u].date!==today) depToday[u] = {date:today, sum:0};
  depToday[u].sum += amt;
}

// ---- глобальная история игр (одна на всех) ----
const HIST_FILE = path.join(__dirname, 'history.json');
let history = [];
function pushHistory(rec){
  history.unshift(rec);
  history = history.slice(0, 300);
  if(supa){
    supa.from('history').insert({
      game_id:rec.gameId, name:rec.name, initials:rec.initials,
      avatar:rec.avatar, amount:rec.amount, mult:rec.mult, t:rec.t
    }).then(()=>{},()=>{});
  }else{
    try{ fs.writeFileSync(HIST_FILE, JSON.stringify(history)); }catch(e){}
  }
}

// ---- статистика игроков (и ботов) ----
const STATS_FILE = path.join(__dirname, 'stats.json');
let stats = {};
let statsDirty = {};   // {key: true} — кого надо записать
let prizeBank = 0;     // банк призовых (копится по 1% от выигрыша)
function saveStatsFile(){ try{ fs.writeFileSync(STATS_FILE, JSON.stringify({stats,prizeBank})); }catch(e){} }
function emptyStat(name,fullName){ return { name:name||'', fullName:fullName||'', games:0, wins:0, wagered:0, won:0, deposits:0, profit:0, bot:false }; }
function getStats(k){ return stats[k] || emptyStat(); }
function statBet(key, name, fullName, amount, firstBet, isBot){
  const s = stats[key] || emptyStat(name,fullName);
  s.name = name || s.name;
  if(fullName) s.fullName = fullName;
  if(isBot) s.bot = true;
  if(firstBet) s.games += 1;
  s.wagered += amount;
  stats[key] = s; statsDirty[key] = true;
}
function statWin(key, takehome, bet){
  const s = stats[key]; if(!s) return;
  s.wins += 1; s.won += takehome;
  s.profit += Math.max(0, takehome - bet);   // чистая прибыль — только прибавляется
  statsDirty[key] = true;
}
function statDeposit(key, name, amount){
  const s = stats[key] || emptyStat(name);
  if(name) s.name = name;
  s.deposits += amount;
  stats[key] = s; statsDirty[key] = true;
}
// сбрасываем изменившуюся статистику раз в 8с (батчем, без нагрузки на каждой ставке)
setInterval(()=>{
  const users = Object.keys(statsDirty);
  if(!users.length && !prizeDirty) return;
  statsDirty = {};
  if(supa){
    if(users.length){
      const rows = users.map(k=>({ ukey:k, name:stats[k].name, full_name:stats[k].fullName||'',
        games:stats[k].games, wins:stats[k].wins, wagered:+stats[k].wagered.toFixed(2),
        won:+stats[k].won.toFixed(2), deposits:+stats[k].deposits.toFixed(2),
        profit:+stats[k].profit.toFixed(2), bot:!!stats[k].bot }));
      supa.from('stats').upsert(rows).then(()=>{},()=>{});
    }
    if(prizeDirty){ supa.from('game_state').upsert({ id:1, game_id:gameCounter, prize_bank:+prizeBank.toFixed(2) }).then(()=>{},()=>{}); prizeDirty=false; }
  }else saveStatsFile();
}, 8000);
let prizeDirty = false;
function addPrize(amount){ prizeBank += amount; prizeDirty = true; }

const avatars = {};   // ukey -> avatar url (для рейтинга)

const PRIZE_GAME = 100000;   // банк распределяется после этой игры
const PRIZE_SPLIT = [0.5, 0.3, 0.2];

// топ по чистой прибыли (игроки + боты), только положительная прибыль
function leaderboard(){
  return Object.entries(stats)
    .map(([key,s])=>({
      key,
      name: s.name || (s.bot?'Бот':'Игрок'),
      avatar: avatars[key] || null,
      bot: !!s.bot,
      profit: +s.profit.toFixed(2),
    }))
    .filter(e=>e.profit>0)
    .sort((a,b)=>b.profit-a.profit);
}

// распределение банка призовых после порога
function maybeDistributePrize(){
  if(gameCounter < PRIZE_GAME || prizeBank<=0) return;
  const top = leaderboard().slice(0,3);
  top.forEach((e,i)=>{
    const cut = prizeBank*PRIZE_SPLIT[i];
    if(!e.bot && e.key.startsWith('u_')){
      const u=e.key.slice(2);
      setBalance(u, getBalance(u)+cut);
      for(const [sid,uu] of Object.entries(sockUser)){ if(uu===u) io.to(sid).emit('balance',{ balance:getBalance(u) }); }
    }
  });
  prizeBank=0; prizeDirty=true;
  io.emit('prizeDone', { top: top.map(e=>({name:e.name,profit:e.profit})) });
}

// ---- загрузка всех данных при старте ----
async function loadAll(){
  if(supa){
    try{
      const b = await supa.from('balances').select('*');
      if(b.data) for(const r of b.data) balances[r.username]=+r.balance;
      const s = await supa.from('stats').select('*');
      if(s.data) for(const r of s.data) stats[r.ukey]={ name:r.name, fullName:r.full_name||'', games:r.games, wins:r.wins, wagered:+r.wagered, won:+r.won, deposits:+(r.deposits||0), profit:+(r.profit||0), bot:!!r.bot };
      const h = await supa.from('history').select('*').order('t',{ascending:false}).limit(300);
      if(h.data) history = h.data.map(r=>({ gameId:r.game_id, name:r.name, initials:r.initials, avatar:r.avatar, amount:+r.amount, mult:+r.mult, t:+r.t }));
      const g = await supa.from('game_state').select('*').eq('id',1).maybeSingle();
      if(g.data && g.data.game_id) gameCounter = g.data.game_id;
      if(g.data && g.data.prize_bank) prizeBank = +g.data.prize_bank;
      console.log('Загружено из Supabase: игра #'+gameCounter+', история '+history.length);
    }catch(e){ console.error('Ошибка загрузки из Supabase:', e.message); }
  }else{
    try{ balances = JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }catch(e){}
    try{ const sf=JSON.parse(fs.readFileSync(STATS_FILE,'utf8')); stats=sf.stats||sf||{}; prizeBank=sf.prizeBank||0; }catch(e){}
    try{ history = JSON.parse(fs.readFileSync(HIST_FILE,'utf8')); }catch(e){}
    try{ const gs=JSON.parse(fs.readFileSync(path.join(__dirname,'gamestate.json'),'utf8')); gameCounter=gs.game_id||0; }catch(e){}
  }
  // миграция: старые записи статистики были на голом юзернейме — переносим на ключ u_<username>
  for(const k of Object.keys(stats)){
    if(!k.startsWith('u_') && !k.startsWith('bot:')){
      const nk='u_'+k;
      if(!stats[nk]) stats[nk]=stats[k];
      delete stats[k];
      statsDirty[nk]=true;
    }
    // на всякий случай добиваем недостающие поля у старых строк
    const s=stats[k]||stats['u_'+k];
    if(s){ if(s.deposits==null)s.deposits=0; if(s.profit==null)s.profit=0; }
  }
}

// сохраняем номер игры, чтобы счётчик не сбрасывался при рестарте
function saveGameCounter(){
  if(supa){ supa.from('game_state').upsert({ id:1, game_id:gameCounter, prize_bank:+prizeBank.toFixed(2) }).then(()=>{},()=>{}); }
  else { try{ fs.writeFileSync(path.join(__dirname,'gamestate.json'), JSON.stringify({game_id:gameCounter})); }catch(e){} }
}

// ================= геометрия и физика (1в1 с клиентом) =================

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}
function polyArea(p){let a=0;for(let i=0;i<p.length;i++){const q=p[i],r=p[(i+1)%p.length];a+=q.x*r.y-r.x*q.y;}return Math.abs(a)/2;}
function clipHalf(poly,n,t,keepLess){const out=[];for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length];let da=n.x*a.x+n.y*a.y-t,db=n.x*b.x+n.y*b.y-t;if(!keepLess){da=-da;db=-db;}if(da<=0)out.push(a);if((da<0&&db>0)||(da>0&&db<0)){const s=da/(da-db);out.push({x:a.x+(b.x-a.x)*s,y:a.y+(b.y-a.y)*s});}}return out;}
function cutByArea(poly,frac,angle){const n={x:-Math.sin(angle),y:Math.cos(angle)};let lo=Infinity,hi=-Infinity;for(const p of poly){const d=n.x*p.x+n.y*p.y;lo=Math.min(lo,d);hi=Math.max(hi,d);}const target=polyArea(poly)*frac;let a=lo,b=hi;for(let i=0;i<42;i++){const m=(a+b)/2;if(polyArea(clipHalf(poly,n,m,true))<target)a=m;else b=m;}const t=(a+b)/2;return [clipHalf(poly,n,t,true),clipHalf(poly,n,t,false)];}
function pointInPoly(pt,poly){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a.y>pt.y)!==(b.y>pt.y)&&pt.x<(b.x-a.x)*(pt.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;}

function buildSectors(players){
  const total=players.reduce((s,p)=>s+p.amount,0);
  const out=[];
  if(total<=0||!players.length) return out;
  const sorted=[...players].sort((a,b)=>a.order-b.order);
  let poly=[{x:0,y:0},{x:FS,y:0},{x:FS,y:FS},{x:0,y:FS}];
  let left=1;
  for(let i=0;i<sorted.length;i++){
    const p=sorted[i], share=p.amount/total;
    let poly2;
    if(i===sorted.length-1||left<=0){ poly2=poly; }
    else{ const frac=Math.min(.999,Math.max(.001,share/left)); const [piece,rest]=cutByArea(poly,frac,p.angle); poly2=piece; poly=rest; }
    left-=share; out.push({id:p.id, poly:poly2});
  }
  return out;
}

// прогон траектории для сида — возвращает точку остановки шайбы
// (та же физика, что на клиенте, со всеми отскоками)
function simPoint(seed){
  const r=mulberry32(seed>>>0);
  const m=160;
  const p={ x:m+r()*(FS-2*m), y:m+r()*(FS-2*m) };
  const angle=r()*Math.PI*2, speed=3300+r()*600;
  p.vx=Math.cos(angle)*speed; p.vy=Math.sin(angle)*speed; p.t=0;
  const e=2;
  for(let i=0;i<2000;i++){
    p.t+=DT; p.x+=p.vx*DT; p.y+=p.vy*DT;
    if(p.x<e){p.x=e;p.vx=Math.abs(p.vx);}
    if(p.x>FS-e){p.x=FS-e;p.vx=-Math.abs(p.vx);}
    if(p.y<e){p.y=e;p.vy=Math.abs(p.vy);}
    if(p.y>FS-e){p.y=FS-e;p.vy=-Math.abs(p.vy);}
    const f=Math.pow(p.t>6?0.3:0.62, DT); p.vx*=f; p.vy*=f;
    const sp=Math.hypot(p.vx,p.vy);
    if(sp<260&&sp>0){ const ns=Math.max(0,sp-150*DT); p.vx*=ns/sp; p.vy*=ns/sp; if(ns<3) break; }
    if(p.t>9) break;
  }
  return { x:p.x, y:p.y };
}

function winnerOfPoint(pt, sectors, players){
  const win=sectors.find(s=>pointInPoly(pt,s.poly));
  return win? win.id : (players[0] && players[0].id);
}

function simulateLanding(seed, players){
  const sectors=buildSectors(players);
  return winnerOfPoint(simPoint(seed), sectors, players);
}

// ================= движок раундов =================

// 300 ботов: имена собираем из прилагательное+существительное, детерминированно
const BOT_ADJ = ['Turbo','Pixel','Neon','Lazy','Star','Ice','Red','Salty','Wild','Dark','Fast','Gold','Grey','Iron','Moon','Ghost','Crypto','Block','Mad','Lucky','Silent','Brave','Frozen','Solar','Lunar','Toxic','Rapid','Royal','Shadow','Crimson','Cosmic','Electric','Hidden','Jolly','Mighty','Noble','Quiet','Rusty','Sharp','Vivid','Atomic','Bold','Cyber','Dizzy','Epic','Fuzzy','Giga','Hyper','Jazzy','Karma'];
const BOT_NOUN = ['Shard','Hawk','Rat','Tiger','Forge','Breaker','Panda','Crab','Boar','Horse','Snail','Finch','Oscar','Whale','Duck','Wolf','Rider','Fox','Falcon','Otter','Lynx','Raven','Cobra','Bison','Moose','Gecko','Hornet','Mantis','Badger','Heron','Marlin','Puma','Stag','Viper','Walrus','Yak','Bat','Crow','Eel','Frog','Goat','Hare','Ibex','Jay','Kite','Loon','Mole','Newt','Owl','Pike'];
const BOT_POOL = (function(){
  const r = mulberry32(123456789);
  const arr=[], seen=new Set();
  while(arr.length<300){
    const name = BOT_ADJ[(r()*BOT_ADJ.length)|0]+' '+BOT_NOUN[(r()*BOT_NOUN.length)|0];
    if(seen.has(name)) continue;
    seen.add(name);
    const anon = r()<0.4;
    arr.push(anon ? { name, anon:true } : { name, user:'@'+name.toLowerCase().replace(/\s/g,'') });
  }
  return arr;
})();
function initialsOf(n){const w=(''+n).replace('@','').trim().split(/\s+/);return (w.length>1?w[0][0]+w[1][0]:w[0].slice(0,2)).toUpperCase();}
function botKey(name){ return 'bot:'+name; }

let state = {
  gameId: 0,
  phase: 'betting',          // betting | resolving
  players: [],
  bettingEnds: 0,
  seed: 0,
  resolve: null,
  lastAngle: null,
  botTimers: [],
  bigCarry: null,            // {who, amount, gamesLeft} — крупный игрок докидывает несколько игр
  sharkSession: 0,           // сколько игр подряд заходят акулы
  rig: null,                 // username, которому подкручиваем (режим админа)
  pending: null,             // отложенный выигрыш (начисляем после анимации)
};

function nextAngle(){
  let a; do{ a=Math.random()*Math.PI; }while(state.lastAngle!==null && Math.abs(a-state.lastAngle)<0.5);
  state.lastAngle=a; return a;
}

function publicPlayers(){
  return state.players.map(p=>({ id:p.id, name:p.name, anon:p.anon, initials:p.initials,
    avatar:p.avatar||null, amount:+p.amount.toFixed(2), order:p.order, angle:p.angle }));
}

function addPlayer(who, amount){
  let p = state.players.find(x=>x.id===who.id);
  if(p){ p.amount += amount; }
  else{
    p = { id:who.id, name:who.name, anon:!!who.anon, initials:who.initials, avatar:who.avatar||null,
          amount, order:state.players.length, angle:nextAngle(), isBot:!!who.isBot,
          username:who.username||null, botName:who.botName||null };
    state.players.push(p);
  }
  return p;
}

function newRound(){
  // применяем отложенный выигрыш прошлой игры — анимация уже доиграла у всех
  if(state.pending){
    const pend=state.pending; state.pending=null;
    if(pend.username){
      setBalance(pend.username, getBalance(pend.username)+pend.takehome);
      for(const [sid,u] of Object.entries(sockUser)){
        if(u===pend.username) io.to(sid).emit('balance',{ balance:getBalance(u) });
      }
    }
    // прибыль/победа в рейтинг — и для игроков, и для ботов
    if(pend.statKey) statWin(pend.statKey, pend.takehome, pend.bet);
    pushHistory(pend.hist);
    maybeDistributePrize();
  }
  gameCounter++;
  state.gameId = gameCounter;
  saveGameCounter();
  state.phase='betting';
  state.players=[];
  state.lastAngle=null;
  state.seed=0; state.resolve=null;
  state.bettingEnds = Date.now()+BETTING_MS;
  scheduleBots();
  io.emit('round', { gameId:state.gameId, players:[], bettingMs:BETTING_MS, elapsedMs:0 });
  // историю прошлой игры рассылаем только сейчас — к этому моменту
  // анимация шайбы у всех уже доиграла, и спойлера победителя не будет
  io.emit('history', history);
  setTimeout(lockRound, BETTING_MS);
}

function botBet(amt, big){
  const b = BOT_POOL[(Math.random()*BOT_POOL.length)|0];
  const dispName = b.user || b.name;
  // стабильный id в раунде по имени — повторная ставка того же бота копится в его сектор
  const who={ id:'bot_'+b.name, name:dispName, anon:!!b.anon, initials:initialsOf(b.name),
              isBot:true, botName:b.name };
  const firstBet = !state.players.find(p=>p.id===who.id);
  addPlayer(who, amt);
  who._amt = amt;
  statBet(botKey(b.name), dispName, '', amt, firstBet, true);
  io.emit('bet', { players: publicPlayers() });
  return who;
}

function scheduleBots(){
  state.botTimers.forEach(clearTimeout); state.botTimers=[];
  const T=(sec,fn)=>state.botTimers.push(setTimeout(()=>{ if(state.phase==='betting') fn(); }, sec*1000));

  // массовка 0.1–10, весь таймер
  const crowd=2+Math.floor(Math.random()*9);
  for(let i=0;i<crowd;i++) T(Math.random()*18, ()=>botBet(+(0.1+Math.random()*9.9).toFixed(1)));
  // мидлы 10–100 на 5–10с до конца
  if(Math.random()<0.6){ const n=1+Math.floor(Math.random()*3); for(let i=0;i<n;i++) T(20-(5+Math.random()*5), ()=>botBet(Math.round(10+Math.random()*90))); }
  // акулы 100–1000 сессиями, снайперят последние 1–3с
  if(state.sharkSession>0){ state.sharkSession--; const n=1+Math.floor(Math.random()*2);
    for(let i=0;i<n;i++) T(20-(1+Math.random()*2), ()=>{ const w=botBet(Math.round(100+Math.random()*900),true); markBig(w); }); }
  else if(Math.random()<0.12){ state.sharkSession=2+Math.floor(Math.random()*4); }
  // кит 1000–10000, редко, в самом конце
  if(Math.random()<0.012) T(20-(1+Math.random()*2), ()=>{ const w=botBet(Math.round(1000+Math.random()*9000),true); markBig(w); });
  // докидывание крупного игрока убывающими суммами — потом перестаёт, суммы не копятся
  if(state.bigCarry && state.bigCarry.gamesLeft>0){
    const c=state.bigCarry; c.gamesLeft--;
    const amt=Math.round(c.amount*0.6);
    if(amt>=10) T(20-(1+Math.random()*3), ()=>{ addPlayer(c.who, amt); io.emit('bet',{players:publicPlayers()}); });
    if(c.gamesLeft<=0) state.bigCarry=null; else c.amount=amt;
  }
}
function markBig(who){ state.bigCarry = { who, amount: who._amt || 500, gamesLeft: 2+Math.floor(Math.random()*2) }; }

function lockRound(){
  if(state.phase!=='betting') return;
  state.phase='resolving';
  state.botTimers.forEach(clearTimeout); state.botTimers=[];

  const bank = state.players.reduce((s,p)=>s+p.amount,0);
  const sectors = buildSectors(state.players);

  let seed, winnerId;
  // режим подкрутки: заранее знаем всю траекторию с отскоками и брутфорсим
  // сид так, чтобы шайба села в сектор указанного игрока
  const rigId = state.rig ? 'u_'+state.rig : null;
  const rigSec = rigId ? sectors.find(s=>s.id===rigId) : null;
  if(rigSec){
    for(let i=0;i<8000;i++){
      const s=(Math.random()*4294967296)>>>0;
      if(pointInPoly(simPoint(s), rigSec.poly)){ seed=s; winnerId=rigId; break; }
    }
  }
  if(seed===undefined){
    seed=(Math.random()*4294967296)>>>0;
    winnerId = state.players.length ? winnerOfPoint(simPoint(seed), sectors, state.players) : null;
  }
  state.seed = seed;
  // подкрутка действует только на одну игру — сбрасываем сразу после применения
  if(state.rig) state.rig=null;

  const winner = state.players.find(p=>p.id===winnerId);

  let takehome=0, mult=0;
  if(winner){
    const net=Math.max(0, bank-winner.amount);
    takehome=winner.amount + net*(1-COMMISSION);
    mult=winner.amount>0? takehome/winner.amount : 0;
    // в банк призовых уходит 1% от чистого выигрыша (1/15 часть комиссии)
    if(net>0) addPrize(net*0.01);
    // начисление и история откладываются до конца анимации (старт след. раунда),
    // чтобы баланс и «Последняя игра» не появлялись раньше остановки шайбы
    state.pending = {
      username: (!winner.isBot && winner.username) ? winner.username : null,
      statKey: winner.isBot ? botKey(winner.botName) : ('u_'+winner.username),
      takehome, bet: winner.amount,
      hist: {
        gameId:state.gameId, name:winner.name, initials:winner.initials,
        avatar:winner.avatar||null, amount:+takehome.toFixed(2), mult:+mult.toFixed(2), t:Date.now()
      }
    };
  }
  state.resolve = { seed:state.seed, players:publicPlayers(), winnerId,
    takehome:+takehome.toFixed(2), mult:+mult.toFixed(2),
    winnerName:winner?winner.name:'', winnerInitials:winner?winner.initials:'',
    winnerAvatar:winner?(winner.avatar||null):null };
  io.emit('resolve', state.resolve);
  setTimeout(newRound, RESOLVE_MS);
}

// ================= сокеты =================

const sockUser = {};  // socketId -> username

io.on('connection', (sock)=>{
  // снапшот текущего состояния
  function buildSnap(){
    return (state.phase==='betting')
      ? { gameId:state.gameId, phase:'betting', players:publicPlayers(),
          bettingMs:BETTING_MS, elapsedMs:Math.max(0, BETTING_MS-(state.bettingEnds-Date.now())) }
      : { gameId:state.gameId, phase:'resolving', players:publicPlayers(),
          bettingMs:BETTING_MS, elapsedMs:BETTING_MS, resolve:state.resolve };
  }
  sock.emit('snapshot', buildSnap());
  sock.emit('history', history);

  // переспрос состояния (например когда апку вернули из фона)
  sock.on('resync', ()=>{ sock.emit('snapshot', buildSnap()); });

  sock.on('auth', (d)=>{
    const u = (d && d.username) ? (''+d.username).toLowerCase() : null;
    sock.data.user = u;
    sock.data.name = d?.name || (u?'@'+u:'Игрок');
    sock.data.fullName = d?.fullName || sock.data.name;   // имя+фамилия из профиля
    sock.data.initials = d?.initials || 'PL';
    sock.data.avatar = d?.avatar || null;
    if(u){ sockUser[sock.id]=u; if(sock.data.avatar) avatars['u_'+u]=sock.data.avatar; sock.emit('balance',{ balance:getBalance(u) }); }
  });

  sock.on('bet', (d)=>{
    const u = sock.data.user;
    if(!u){ sock.emit('reject',{msg:'Нужен юзернейм в Telegram'}); return; }
    if(state.phase!=='betting'){ sock.emit('reject',{msg:'Раунд уже идёт'}); return; }
    let amount = +d?.amount;
    if(!(amount>=MIN_BET)){ sock.emit('reject',{msg:'Минимум 0.1 TON'}); return; }
    const bal=getBalance(u);
    if(bal<amount){ sock.emit('reject',{msg:'Недостаточно TON'}); return; }
    setBalance(u, bal-amount);
    const firstBet = !state.players.find(p=>p.id==='u_'+u);
    addPlayer({ id:'u_'+u, name:sock.data.name, initials:sock.data.initials,
                avatar:sock.data.avatar, anon:false, isBot:false, username:u }, amount);
    statBet('u_'+u, sock.data.name, sock.data.fullName, amount, firstBet);
    if(sock.data.avatar) avatars['u_'+u] = sock.data.avatar;
    sock.emit('balance',{ balance:getBalance(u) });
    io.emit('bet', { players: publicPlayers() });
  });

  sock.on('deposit', (d)=>{
    const u = sock.data.user;
    if(!u){ sock.emit('reject',{msg:'Нужен юзернейм в Telegram'}); return; }
    let amount=+d?.amount;
    if(!(amount>0)){ return; }
    const left=depLeft(u);
    if(left<=0){ sock.emit('reject',{msg:'Дневной лимит пополнения исчерпан'}); return; }
    amount=Math.min(amount,left);
    addDep(u, amount);
    setBalance(u, getBalance(u)+amount);
    statDeposit('u_'+u, sock.data.name, amount);
    sock.emit('balance',{ balance:getBalance(u) });
  });

  sock.on('disconnect', ()=>{ delete sockUser[sock.id]; });

  // запрос рейтинга: топ по чистой прибыли + банк призовых + моё место
  sock.on('leaderboard', ()=>{
    const lb = leaderboard();
    const top = lb.slice(0,50).map((e,i)=>({ rank:i+1, name:e.name, avatar:e.avatar, profit:e.profit, bot:e.bot }));
    let myRank=0, myProfit=0;
    const u = sock.data.user;
    if(u){
      const idx = lb.findIndex(e=>e.key==='u_'+u);
      if(idx>=0){ myRank=idx+1; myProfit=lb[idx].profit; }
    }
    sock.emit('leaderboard', {
      top, total: lb.length,
      prizeBank: +prizeBank.toFixed(2),
      prizeGame: PRIZE_GAME, gameId: state.gameId,
      myRank, myProfit, myName: sock.data.name||null, myAvatar: sock.data.avatar||null,
    });
  });
});

// ================= телеграм-бот =================

function isOwner(msg){ return msg.from && (msg.from.id===OWNER_ID || (msg.from.username||'').toLowerCase()===OWNER_USERNAME); }

// инлайн-режим: @bot username -> карточка статистики; для владельца ещё «N @username» -> пополнить
bot.on('inline_query', (q)=>{
  const query = (q.query||'').trim();
  const results = [];
  const ownerHere = q.from && q.from.id===OWNER_ID;

  // владелец: "50 @username" или "@username 50" -> пополнение баланса
  const topup = ownerHere ? parseTopup(query) : null;
  if(topup){
    results.push({
      type:'article', id:`topup:${topup.amount}:${topup.user}`,
      title:`Пополнить @${topup.user} на ${fmtTon(topup.amount)} TON`,
      description:'Только для владельца — отправь, чтобы начислить баланс',
      input_message_content:{ message_text:`Баланс @${topup.user} пополнен на ${fmtTon(topup.amount)} TON.` },
    });
  }

  const raw = query.replace(/^@/,'').replace(/\s.*$/,'').toLowerCase();
  if(raw && !/^\d/.test(raw)){
    const s = stats['u_'+raw];
    if(s){
      const winrate = s.games>0 ? (s.wins/s.games*100) : 0;
      const earned = s.won - s.wagered;
      const display = s.fullName || s.name || ('@'+raw);
      const sign = earned>=0?'+':'';
      // HTML — надёжнее Markdown, ссылка зашита прямо в жирный текст Anticasino
      const text =
        `<b>Игрок: ${htmlEsc(display)} (@${raw})</b>\n\n`+
        `<b>PVP Arena</b>\n`+
        `Игр: ${s.games} (побед: ${s.wins}, winrate: ${winrate.toFixed(1)}%)\n`+
        `Поставлено: <b>${fmtTon(s.wagered)} TON</b>\n`+
        `Выиграно: <b>${fmtTon(s.won)} TON</b>\n`+
        `Заработано: <b>${sign}${fmtTon(earned)} TON</b>\n`+
        `Сделано депозитов: <b>${fmtTon(s.deposits||0)} TON</b>\n\n`+
        `<b><a href="${APP_LINK}">${APP_NAME}</a></b>`;
      results.push({
        type:'article', id:'stat_'+raw,
        title:`Статистика ${display}`,
        description:`Игр: ${s.games} · winrate ${winrate.toFixed(0)}% · заработано ${sign}${fmtTon(earned)} TON`,
        input_message_content:{ message_text:text, parse_mode:'HTML', disable_web_page_preview:true },
      });
    }else{
      results.push({
        type:'article', id:'nostat_'+raw,
        title:`@${raw} ещё не играл`,
        description:'Нет статистики по этому игроку',
        input_message_content:{ message_text:`У @${raw} пока нет статистики в ${APP_NAME}.` },
      });
    }
  }
  if(!results.length){
    results.push({
      type:'article', id:'hint',
      title:'Введите юзернейм игрока',
      description:'Например: @username — покажу статистику ставок',
      input_message_content:{ message_text:`Чтобы посмотреть статистику игрока в ${APP_NAME}, напиши его юзернейм после имени бота.` },
    });
  }
  bot.answerInlineQuery(q.id, results, { cache_time:0, is_personal:true }).catch(()=>{});
});

// разбор "50 @user" / "@user 50" / "50 user"
function parseTopup(query){
  const m = query.match(/^([\d.,]+)\s+@?(\w+)$/) || query.match(/^@?(\w+)\s+([\d.,]+)$/);
  if(!m) return null;
  let amount, user;
  if(/[\d.,]/.test(m[1][0])){ amount=parseFloat(m[1].replace(',','.')); user=m[2].toLowerCase(); }
  else { user=m[1].toLowerCase(); amount=parseFloat(m[2].replace(',','.')); }
  if(!amount||amount<=0) return null;
  return { amount:+amount.toFixed(2), user };
}

// фактическое пополнение происходит, когда владелец ВЫБРАЛ результат пополнения
bot.on('chosen_inline_result', (r)=>{
  if(!r.result_id || !r.result_id.startsWith('topup:')) return;
  if(!r.from || r.from.id!==OWNER_ID) return;   // двойная проверка: только владелец
  const [,amtStr,user] = r.result_id.split(':');
  const amount = parseFloat(amtStr);
  if(!user || !(amount>0)) return;
  setBalance(user, getBalance(user)+amount);
  statDeposit('u_'+user, '@'+user, amount);     // выданное админом считается депозитом
  for(const [sid,uu] of Object.entries(sockUser)){
    if(uu===user) io.to(sid).emit('balance',{ balance:getBalance(user) });
  }
});

function fmtTon(n){
  n = +(+n).toFixed(2);
  if(Math.abs(n)>=1000) return n.toLocaleString('ru-RU');
  return (n%1===0)? String(n) : n.toFixed(2);
}
// экранируем спецсимволы Markdown в имени, чтобы карточка не сломалась
function mdEsc(s){ return (''+s).replace(/([_*\[\]()`])/g, '\\$1'); }
function htmlEsc(s){ return (''+s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

bot.onText(/^\/buy\s+([\d.,]+)\s+@?(\w+)/i, (msg, match)=>{
  if(!isOwner(msg)) return;
  const amount=parseFloat(match[1].replace(',','.'));
  const username=match[2].toLowerCase();
  if(!amount||amount<=0){ bot.sendMessage(msg.chat.id,'Пример: /buy 50 @username'); return; }
  setBalance(username, getBalance(username)+amount);
  // живым сокетам этого юзера шлём новый баланс
  for(const [sid,u] of Object.entries(sockUser)){ if(u===username) io.to(sid).emit('balance',{ balance:getBalance(username) }); }

  const ph='💎';
  const text = ph+` Баланс @${username} пополнен на ${amount} `+ph;
  bot.sendMessage(msg.chat.id, text, { entities:[
    { type:'custom_emoji', offset:0, length:ph.length, custom_emoji_id:EMOJI_LEFT },
    { type:'custom_emoji', offset:text.length-ph.length, length:ph.length, custom_emoji_id:EMOJI_RIGHT },
  ]}).catch(()=>bot.sendMessage(msg.chat.id, `Баланс @${username} пополнен на ${amount}`));
});

// подкрутка (только владелец): /rigging @username — шайба будет садиться этому игроку
// /rigging off — выключить, /rigging — показать статус
bot.onText(/^\/rigging(?:\s+@?(\w+))?/i, (msg, match)=>{
  if(!isOwner(msg)) return;
  const arg = match[1] ? match[1].toLowerCase() : null;
  if(!arg){
    bot.sendMessage(msg.chat.id, state.rig ? `Подкрутка включена на @${state.rig}` : 'Подкрутка выключена. Команды: /rigging @username, /rigging off');
    return;
  }
  if(arg==='off'){
    state.rig=null;
    bot.sendMessage(msg.chat.id, 'Подкрутка выключена');
    return;
  }
  state.rig=arg;
  bot.sendMessage(msg.chat.id, `Подкрутка включена на @${arg}. Шайба будет садиться ему, пока он в игре. Выключить: /rigging off`);
});

bot.onText(/^\/balance/, (msg)=>{
  const u=(msg.from.username||'').toLowerCase();
  bot.sendMessage(msg.chat.id, `Твой баланс: ${getBalance(u)} TON`);
});

// ================= http =================

app.use((req,res,next)=>{ res.setHeader('Access-Control-Allow-Origin','*'); next(); });
app.get('/api/balance/:username', (req,res)=>{ const u=req.params.username.toLowerCase().replace('@',''); res.json({ username:u, balance:getBalance(u) }); });
app.get('/api/history', (req,res)=>{ res.json(history); });
app.get('/', (req,res)=>res.send('arena online ok, game #'+state.gameId));

const PORT = process.env.PORT || 3000;
server.listen(PORT, async ()=>{
  console.log('сервер на порту', PORT);
  await loadAll();
  newRound();
});