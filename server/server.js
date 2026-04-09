// ═══════════════════════════════════════════════════════════════
// CRYPTO ROULETTE — Server v3
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'client')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });
const PORT = process.env.PORT || 3000;

const CONFIG = {
  MAX_PLAYERS: 32,
  TIMER_DURATION: 15,
  COMMISSION: 0.15,
  MIN_BET: 0.1,
  MAX_BET: 10000,
  ARENA_SIZE: 600,
  PUCK_RADIUS: 16,
  PUCK_FRICTION: 0.991,       // меньше трение = дольше летает (was 0.985)
  PUCK_MIN_SPEED: 0.25,
  PHYSICS_FPS: 60,
  SPIN_DURATION: 3500,         // стрелка крутится 3.5 сек
  RESULT_DISPLAY: 4000,
  PAUSE_BETWEEN: 3000,
  INITIAL_BALANCE: 1000,
};

function generateServerSeed() { return crypto.randomBytes(32).toString('hex'); }
function generatePublicSeed() { return crypto.randomBytes(16).toString('hex'); }
function hashSeed(seed) { return crypto.createHash('sha256').update(seed).digest('hex'); }
function seededRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return function() { h = (h * 1103515245 + 12345) & 0x7fffffff; return h / 0x7fffffff; };
}

const playerBalances = new Map();
const playerNames = new Map(); // socketId -> name

let gameState = {
  phase: 'waiting', roundId: 0, players: [], totalPool: 0,
  timer: CONFIG.TIMER_DURATION, serverSeed: null, publicSeed: null,
  seedHash: null, puck: null, sectors: [], winner: null,
  topGame: { name: '—', initials: '—', amount: 0 },
  lastGame: { name: '—', initials: '—', amount: 0 },
};
let timerInterval = null, physicsInterval = null;

// ── Squarified Treemap ──
function calculateSectors(players, totalPool, arenaSize) {
  if (!players.length) return [];
  const sectors = [];
  const sorted = [...players].sort((a, b) => b.bet - a.bet);
  function squarify(items, x, y, w, h) {
    if (!items.length) return;
    if (items.length === 1) {
      const p = items[0];
      sectors.push({ playerId:p.id, name:p.name, avatar:p.avatar, initials:p.initials, color:p.color, bet:p.bet,
        percent:(p.bet/totalPool*100).toFixed(1), x, y, w, h, cx:x+w/2, cy:y+h/2 });
      return;
    }
    const tv = items.reduce((s,p) => s+p.bet, 0);
    const vert = w >= h;
    let bestRow = [items[0]], bestRatio = Infinity;
    for (let i = 0; i < items.length; i++) {
      const row = items.slice(0, i+1), rv = row.reduce((s,p) => s+p.bet, 0);
      const rf = rv/tv, strip = vert ? w*rf : h*rf;
      let worst = 0;
      for (const p of row) {
        const pf = p.bet/rv;
        const cw = vert ? strip : w*pf, ch = vert ? h*pf : strip;
        worst = Math.max(worst, Math.max(cw/Math.max(ch,.1), ch/Math.max(cw,.1)));
      }
      if (worst <= bestRatio || i === 0) { bestRatio = worst; bestRow = row; } else break;
    }
    const rv = bestRow.reduce((s,p) => s+p.bet, 0), strip = vert ? w*(rv/tv) : h*(rv/tv);
    let off = 0;
    for (const p of bestRow) {
      const pf = p.bet/rv, cell = vert ? h*pf : w*pf;
      const sx = vert?x:x+off, sy = vert?y+off:y, sw = vert?strip:cell, sh = vert?cell:strip;
      sectors.push({ playerId:p.id, name:p.name, avatar:p.avatar, initials:p.initials, color:p.color, bet:p.bet,
        percent:(p.bet/totalPool*100).toFixed(1), x:sx, y:sy, w:sw, h:sh, cx:sx+sw/2, cy:sy+sh/2 });
      off += cell;
    }
    const rest = items.slice(bestRow.length);
    if (rest.length) { if (vert) squarify(rest, x+strip, y, w-strip, h); else squarify(rest, x, y+strip, w, h-strip); }
  }
  squarify(sorted, 0, 0, arenaSize, arenaSize);
  return sectors;
}

// ── Physics ──
function initPuck(rng) {
  const m = CONFIG.ARENA_SIZE * 0.2;
  const x = m + rng()*(CONFIG.ARENA_SIZE-2*m), y = m + rng()*(CONFIG.ARENA_SIZE-2*m);
  const angle = rng()*Math.PI*2;
  const speed = 24 + rng()*12; // сильнее импульс (was 18+10)
  return { x, y, vx:Math.cos(angle)*speed, vy:Math.sin(angle)*speed,
    radius:CONFIG.PUCK_RADIUS, spinAngle:0, impulsAngle:angle, launched:false };
}

function stepPhysics(puck) {
  if (!puck || !puck.launched) return puck;
  const s = CONFIG.ARENA_SIZE, r = puck.radius;
  puck.x += puck.vx; puck.y += puck.vy;
  if (puck.x-r<=0){puck.x=r;puck.vx=Math.abs(puck.vx)*0.96;}
  if (puck.x+r>=s){puck.x=s-r;puck.vx=-Math.abs(puck.vx)*0.96;}
  if (puck.y-r<=0){puck.y=r;puck.vy=Math.abs(puck.vy)*0.96;}
  if (puck.y+r>=s){puck.y=s-r;puck.vy=-Math.abs(puck.vy)*0.96;}
  puck.vx *= CONFIG.PUCK_FRICTION; puck.vy *= CONFIG.PUCK_FRICTION;
  puck.spinAngle += Math.sqrt(puck.vx**2+puck.vy**2)*0.05;
  return puck;
}

function isPuckStopped(p) { return !p || Math.sqrt(p.vx**2+p.vy**2) < CONFIG.PUCK_MIN_SPEED; }

function findWinner(puck, sectors) {
  if (!puck || !sectors.length) return null;
  for (const s of sectors) if (puck.x>=s.x && puck.x<=s.x+s.w && puck.y>=s.y && puck.y<=s.y+s.h) return s;
  let min=Infinity, c=sectors[0];
  for (const s of sectors) { const d=(puck.x-s.cx)**2+(puck.y-s.cy)**2; if(d<min){min=d;c=s;} }
  return c;
}

// ── Bots ──
const BOT_NAMES = [
  '@cryptowolf','@moonshot','@diamond_hands','@whale_alert','@degen_king',
  '@ton_maxi','@hodler42','@nft_queen','@alpha_hunter','@block_wizard',
  '@satoshi_jr','@pump_master','@chain_smoker','@gas_fee','@rug_check',
  '@yield_farm','@stake_pool','@swap_lord','@bridge_troll','@dao_voter',
  '@meta_verse','@pixel_punk','@ape_strong','@bear_trap','@bull_run',
  'Grey Oscar','Anna K.','Max Power','Luna Star','Crypto Ninja',
  'Блокчейн Бро','ТОН Мастер','Кит Моби','Алмазные Руки','Король Дегенов',
];
const BOT_COLORS = [
  '#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F',
  '#BB8FCE','#85C1E9','#F0B27A','#82E0AA','#F1948A','#85929E','#73C6B6','#E74C3C',
  '#3498DB','#2ECC71','#F39C12','#9B59B6','#1ABC9C','#E67E22','#34495E','#E91E63',
  '#00BCD4','#FF9800','#8BC34A','#FF5722','#607D8B','#795548','#FF69B4','#00CED1',
];

function getInitials(n) {
  if (n.startsWith('@')) return n.substring(1,3).toUpperCase();
  const p = n.split(/[\s.]+/).filter(Boolean);
  return p.length>=2 ? (p[0][0]+p[1][0]).toUpperCase() : n.substring(0,2).toUpperCase();
}

let usedBotNames = new Set(), roundCounter = 0;
function genBotBet(c) {
  const r = {mass:[0.1,10],mid:[10,100],shark:[100,1000],whale:[1000,10000]}[c];
  return Math.round(Math.exp(Math.log(r[0])+Math.random()*(Math.log(r[1])-Math.log(r[0])))*100)/100;
}
function pickBot() {
  let a=BOT_NAMES.filter(n=>!usedBotNames.has(n)); if(!a.length){usedBotNames.clear();a=BOT_NAMES;}
  const n=a[Math.floor(Math.random()*a.length)]; usedBotNames.add(n); return n;
}
function scheduleBots() {
  const h=(new Date().getUTCHours()+3)%24;
  let cfg;
  if(h>=2&&h<7) cfg={min:2,max:5,sc:0.02}; else if(h>=17&&h<23) cfg={min:6,max:20,sc:0.12};
  else cfg={min:3,max:10,sc:0.06};
  roundCounter++;
  const num=cfg.min+Math.floor(Math.random()*(cfg.max-cfg.min+1)), bots=[];
  for(let i=0;i<num;i++){
    let cl='mass'; const r=Math.random();
    if(r<0.005&&roundCounter%80===0)cl='whale'; else if(r<cfg.sc)cl='shark'; else if(r<cfg.sc+0.25)cl='mid';
    let d;
    if(cl==='whale'||cl==='shark')d=(CONFIG.TIMER_DURATION-3+Math.random()*2.5)*1000;
    else if(cl==='mid')d=(5+Math.random()*5)*1000;
    else d=Math.random()*(CONFIG.TIMER_DURATION-1)*1000;
    bots.push({name:pickBot(),bet:genBotBet(cl),color:BOT_COLORS[Math.floor(Math.random()*BOT_COLORS.length)],delay:d});
  }
  return bots;
}

// ── Game Loop ──
function resetRound() {
  gameState.roundId++; gameState.phase='waiting'; gameState.players=[];
  gameState.totalPool=0; gameState.timer=CONFIG.TIMER_DURATION;
  gameState.puck=null; gameState.sectors=[]; gameState.winner=null;
  gameState.serverSeed=generateServerSeed(); gameState.publicSeed=generatePublicSeed();
  gameState.seedHash=hashSeed(gameState.serverSeed); usedBotNames.clear();
  broadcastState();
  setTimeout(()=>{
    if(gameState.phase==='waiting'){addBotBet();setTimeout(()=>{if(gameState.phase==='waiting')addBotBet();},1000+Math.random()*1000);}
  },1000+Math.random()*2000);
}

function addBotBet() {
  if(gameState.players.length>=CONFIG.MAX_PLAYERS||!['waiting','countdown'].includes(gameState.phase)) return;
  const n=pickBot(),cl=Math.random()<0.7?'mass':'mid';
  addPlayer({id:'bot_'+Date.now()+'_'+Math.random().toString(36).substr(2,5),
    name:n,initials:getInitials(n),avatar:null,bet:genBotBet(cl),
    color:BOT_COLORS[gameState.players.length%BOT_COLORS.length],isBot:true});
}

function addPlayer(player) {
  if(gameState.players.length>=CONFIG.MAX_PLAYERS||['live','spinning','result','paused'].includes(gameState.phase)) return false;
  gameState.players.push(player);
  gameState.totalPool=Math.round(gameState.players.reduce((s,p)=>s+p.bet,0)*100)/100;
  gameState.sectors=calculateSectors(gameState.players,gameState.totalPool,CONFIG.ARENA_SIZE);
  if(gameState.players.length>=2&&gameState.phase==='waiting') startCountdown();
  broadcastState(); return true;
}

function startCountdown() {
  gameState.phase='countdown'; gameState.timer=CONFIG.TIMER_DURATION;
  scheduleBots().forEach(b=>{
    setTimeout(()=>{
      if(gameState.phase!=='countdown'||gameState.players.length>=CONFIG.MAX_PLAYERS) return;
      addPlayer({id:'bot_'+Date.now()+'_'+Math.random().toString(36).substr(2,5),
        name:b.name,initials:getInitials(b.name),avatar:null,bet:b.bet,color:b.color,isBot:true});
    },b.delay);
  });
  clearInterval(timerInterval);
  timerInterval=setInterval(()=>{
    gameState.timer--; if(gameState.timer<=0){clearInterval(timerInterval);startSpinning();}
    broadcastState();
  },1000);
}

function startSpinning() {
  gameState.phase='spinning';
  gameState.puck=initPuck(seededRandom(gameState.serverSeed+gameState.publicSeed));
  broadcastState();
  // Стрелка крутится SPIN_DURATION, потом запуск
  setTimeout(()=>{
    if(gameState.puck){gameState.puck.launched=true;gameState.phase='live';broadcastState();startPhysicsLoop();}
  },CONFIG.SPIN_DURATION);
}

function startPhysicsLoop() {
  let fc=0; clearInterval(physicsInterval);
  physicsInterval=setInterval(()=>{
    if(!gameState.puck){clearInterval(physicsInterval);return;}
    gameState.puck=stepPhysics(gameState.puck); fc++;
    if(fc%2===0) io.emit('puck_update',{x:gameState.puck.x,y:gameState.puck.y,vx:gameState.puck.vx,vy:gameState.puck.vy,spinAngle:gameState.puck.spinAngle});
    if(isPuckStopped(gameState.puck)){clearInterval(physicsInterval);endRound();}
  },1000/CONFIG.PHYSICS_FPS);
}

function endRound() {
  gameState.phase='result';
  const ws=findWinner(gameState.puck,gameState.sectors);
  if(ws){
    const p=gameState.players.find(pl=>pl.id===ws.playerId);
    const bet=p?p.bet:0;
    const netProfit=gameState.totalPool-bet;
    const commission=Math.round(netProfit*CONFIG.COMMISSION*100)/100;
    const winAmount=Math.round((gameState.totalPool-commission)*100)/100;
    const profit=Math.round((winAmount-bet)*100)/100;
    const mult=bet>0?Math.round((winAmount/bet)*100)/100:1;
    const pct=bet>0?(bet/gameState.totalPool*100).toFixed(1):'0';

    gameState.winner={name:ws.name,initials:ws.initials,color:ws.color,
      amount:winAmount,bet,multiplier:mult,profit,percent:pct,sectorId:ws.playerId};

    // Возвращаем ставку + профит реальному игроку
    if(!ws.playerId.startsWith('bot_')&&playerBalances.has(ws.playerId)){
      // winAmount = ставка + чистый профит - комиссия, зачисляем всё
      const newBal=Math.round((playerBalances.get(ws.playerId)+winAmount)*100)/100;
      playerBalances.set(ws.playerId,newBal);
      io.to(ws.playerId).emit('balance_update',{balance:newBal});
    }

    if(winAmount>gameState.topGame.amount) gameState.topGame={name:ws.name,initials:ws.initials,amount:winAmount};
    gameState.lastGame={name:ws.name,initials:ws.initials,amount:profit};
  }
  broadcastState();
  setTimeout(()=>{gameState.phase='paused';broadcastState();setTimeout(resetRound,CONFIG.PAUSE_BETWEEN);},CONFIG.RESULT_DISPLAY);
}

function broadcastState() {
  io.emit('game_state',{
    phase:gameState.phase, roundId:gameState.roundId,
    players:gameState.players.map(p=>({id:p.id,name:p.name,initials:p.initials,avatar:p.avatar,bet:p.bet,color:p.color})),
    totalPool:gameState.totalPool, timer:gameState.timer, seedHash:gameState.seedHash,
    sectors:gameState.sectors,
    puck:gameState.puck?{x:gameState.puck.x,y:gameState.puck.y,vx:gameState.puck.vx,vy:gameState.puck.vy,
      spinAngle:gameState.puck.spinAngle,impulsAngle:gameState.puck.impulsAngle,launched:gameState.puck.launched,radius:gameState.puck.radius}:null,
    winner:gameState.winner, topGame:gameState.topGame, lastGame:gameState.lastGame,
  });
}

// ── Socket.IO ──
io.on('connection',(socket)=>{
  console.log(`[+] ${socket.id}`);
  if(!playerBalances.has(socket.id)) playerBalances.set(socket.id,CONFIG.INITIAL_BALANCE);
  socket.emit('balance_update',{balance:playerBalances.get(socket.id)});
  broadcastState();

  socket.on('set_name',(data)=>{
    if(data.name&&typeof data.name==='string') playerNames.set(socket.id,data.name.substring(0,20));
  });

  socket.on('place_bet',(data)=>{
    const {name,bet,avatar}=data;
    if(!name||typeof name!=='string'||name.length>30) return socket.emit('error',{message:'Неверное имя'});
    const ba=Math.round(parseFloat(bet)*100)/100;
    if(isNaN(ba)||ba<CONFIG.MIN_BET||ba>CONFIG.MAX_BET) return socket.emit('error',{message:`Ставка от ${CONFIG.MIN_BET} до ${CONFIG.MAX_BET} TON`});
    if(['live','spinning','result','paused'].includes(gameState.phase)) return socket.emit('error',{message:'Ждите следующий раунд'});
    if(gameState.players.length>=CONFIG.MAX_PLAYERS) return socket.emit('error',{message:'Все слоты заняты'});
    if(gameState.players.find(p=>p.id===socket.id)) return socket.emit('error',{message:'Вы уже в раунде'});
    const bal=playerBalances.get(socket.id)||0;
    if(ba>bal) return socket.emit('error',{message:`Недостаточно. Баланс: ${bal} TON`});
    playerBalances.set(socket.id,Math.round((bal-ba)*100)/100);
    socket.emit('balance_update',{balance:playerBalances.get(socket.id)});
    // Сохраняем имя
    playerNames.set(socket.id,name.substring(0,20));
    const ok=addPlayer({id:socket.id,name:name.substring(0,20),initials:getInitials(name),avatar:avatar||null,bet:ba,color:BOT_COLORS[gameState.players.length%BOT_COLORS.length],isBot:false});
    if(ok) socket.emit('bet_accepted',{bet:ba});
    else {playerBalances.set(socket.id,Math.round((playerBalances.get(socket.id)+ba)*100)/100);socket.emit('balance_update',{balance:playerBalances.get(socket.id)});}
  });

  socket.on('disconnect',()=>console.log(`[-] ${socket.id}`));
});

server.listen(PORT,()=>{console.log(`\n🎰 Crypto Roulette v3 on port ${PORT}\n📡 http://localhost:${PORT}\n`);resetRound();});