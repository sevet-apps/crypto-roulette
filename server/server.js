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
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---- балансы (файл; для прода лучше Supabase) ----
const DB_FILE = path.join(__dirname, 'balances.json');
let balances = {};
try { balances = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
function saveBalances(){ try{ fs.writeFileSync(DB_FILE, JSON.stringify(balances,null,2)); }catch(e){} }
function getBalance(u){ return balances[u] || 0; }
function setBalance(u,v){ balances[u] = +(+v).toFixed(2); saveBalances(); }

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
try { history = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch (e) {}
function pushHistory(rec){
  history.unshift(rec);
  history = history.slice(0, 300);
  try{ fs.writeFileSync(HIST_FILE, JSON.stringify(history)); }catch(e){}
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

const BOT_POOL = [
  {name:'Turbo Shard', anon:true},{name:'Block Crusher', user:'@blkcrush'},
  {name:'Pixel Hawk', user:'@pxhawk'},{name:'Moon Duck', anon:true},
  {name:'Neon Rat', user:'@neon_rat'},{name:'Crypto Wolf', user:'@cwolf'},
  {name:'Lazy Tiger', user:'@lazytgr'},{name:'Star Forge', anon:true},
  {name:'Ice Breaker', user:'@icebrk'},{name:'Red Panda', user:'@rpanda'},
  {name:'Ghost Rider', anon:true},{name:'Salty Crab', user:'@scrab'},
  {name:'Wild Boar', user:'@wboar'},{name:'Dark Horse', anon:true},
  {name:'Fast Snail', user:'@fsnail'},{name:'Gold Finch', user:'@gfinch'},
  {name:'Grey Oscar', user:'@greyoscar'},{name:'Iron Whale', anon:true},
];
function initialsOf(n){const w=(''+n).replace('@','').trim().split(/\s+/);return (w.length>1?w[0][0]+w[1][0]:w[0].slice(0,2)).toUpperCase();}

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
          amount, order:state.players.length, angle:nextAngle(), isBot:!!who.isBot, username:who.username||null };
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
    pushHistory(pend.hist);
  }
  state.gameId++;
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
  const pool=[...BOT_POOL].sort(()=>Math.random()-.5);
  const b=pool[0];
  const who={ id:'bot_'+b.name+'_'+Math.random().toString(36).slice(2,6),
              name:b.user||b.name, anon:!!b.anon, initials:initialsOf(b.name), isBot:true };
  addPlayer(who, amt);
  who._amt = amt;
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
    // начисление и история откладываются до конца анимации (старт след. раунда),
    // чтобы баланс и «Последняя игра» не появлялись раньше остановки шайбы
    state.pending = {
      username: (!winner.isBot && winner.username) ? winner.username : null,
      takehome,
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
    sock.data.initials = d?.initials || 'PL';
    sock.data.avatar = d?.avatar || null;
    if(u){ sockUser[sock.id]=u; sock.emit('balance',{ balance:getBalance(u) }); }
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
    addPlayer({ id:'u_'+u, name:sock.data.name, initials:sock.data.initials,
                avatar:sock.data.avatar, anon:false, isBot:false, username:u }, amount);
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
    sock.emit('balance',{ balance:getBalance(u) });
  });

  sock.on('disconnect', ()=>{ delete sockUser[sock.id]; });
});

// ================= телеграм-бот =================

function isOwner(msg){ return msg.from && (msg.from.id===OWNER_ID || (msg.from.username||'').toLowerCase()===OWNER_USERNAME); }

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
server.listen(PORT, ()=>{ console.log('сервер на порту', PORT); newRound(); });
