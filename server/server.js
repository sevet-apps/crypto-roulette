// ═══════════════════════════════════════════════════════════════
// CRYPTO ROULETTE — Authoritative Server
// Proportional roulette with physics puck simulation
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
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const CONFIG = {
  MAX_PLAYERS: 32,
  TIMER_DURATION: 15,         // секунд
  COMMISSION: 0.15,           // 15%
  MIN_BET: 0.1,
  MAX_BET: 10000,
  ARENA_SIZE: 600,            // логические пиксели арены
  PUCK_RADIUS: 12,
  PUCK_FRICTION: 0.985,       // трение за кадр
  PUCK_MIN_SPEED: 0.3,        // минимальная скорость для остановки
  PHYSICS_FPS: 60,
  SPIN_DURATION: 2000,        // мс раскрутки
  RESULT_DISPLAY: 4000,       // мс показа результата
  PAUSE_BETWEEN: 3000,        // мс паузы между раундами
};

// ═══════════════════════════════════════════════════════════════
// PROVABLY FAIR — seed generation
// ═══════════════════════════════════════════════════════════════
function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function generatePublicSeed() {
  return crypto.randomBytes(16).toString('hex');
}

function hashSeed(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

// Детерминированный PRNG из seed
function seededRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return function() {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return h / 0x7fffffff;
  };
}

// ═══════════════════════════════════════════════════════════════
// GAME STATE
// ═══════════════════════════════════════════════════════════════
let gameState = {
  phase: 'waiting',      // waiting | countdown | spinning | live | result | paused
  roundId: 39253,
  players: [],           // { id, name, avatar, bet, color, isBot }
  totalPool: 0,
  timer: CONFIG.TIMER_DURATION,
  serverSeed: null,
  publicSeed: null,
  seedHash: null,
  puck: null,            // { x, y, vx, vy, angle, spinAngle }
  sectors: [],           // рассчитанные сектора
  winner: null,
  topGame: { name: 'Grey Oscar', initials: 'GO', amount: 28001 },
  lastGame: { name: '@narcissist', initials: 'NA', amount: 120 },
};

let timerInterval = null;
let physicsInterval = null;
let botManager = null;

// ═══════════════════════════════════════════════════════════════
// SECTOR CALCULATION — квадратная арена
// Делим квадрат на прямоугольные секторы пропорционально ставкам
// ═══════════════════════════════════════════════════════════════
function calculateSectors(players, totalPool, arenaSize) {
  if (players.length === 0) return [];
  
  const sectors = [];
  const sorted = [...players].sort((a, b) => b.bet - a.bet);
  
  // Алгоритм "treemap" для квадрата — используем slice-and-dice
  function sliceAndDice(items, x, y, w, h, vertical) {
    if (items.length === 0) return;
    if (items.length === 1) {
      sectors.push({
        playerId: items[0].id,
        name: items[0].name,
        avatar: items[0].avatar,
        initials: items[0].initials,
        color: items[0].color,
        bet: items[0].bet,
        percent: (items[0].bet / totalPool * 100).toFixed(1),
        x, y, w, h,
        cx: x + w / 2,
        cy: y + h / 2,
      });
      return;
    }
    
    const totalBet = items.reduce((s, p) => s + p.bet, 0);
    let accumulated = 0;
    let splitIndex = 0;
    
    // Ищем точку разделения ~50/50 по весу
    for (let i = 0; i < items.length - 1; i++) {
      accumulated += items[i].bet;
      if (accumulated >= totalBet / 2) {
        splitIndex = i + 1;
        break;
      }
    }
    if (splitIndex === 0) splitIndex = 1;
    
    const firstHalf = items.slice(0, splitIndex);
    const secondHalf = items.slice(splitIndex);
    const firstWeight = firstHalf.reduce((s, p) => s + p.bet, 0) / totalBet;
    
    if (vertical) {
      const splitW = w * firstWeight;
      sliceAndDice(firstHalf, x, y, splitW, h, !vertical);
      sliceAndDice(secondHalf, x + splitW, y, w - splitW, h, !vertical);
    } else {
      const splitH = h * firstWeight;
      sliceAndDice(firstHalf, x, y, w, splitH, !vertical);
      sliceAndDice(secondHalf, x, y + splitH, w, h - splitH, !vertical);
    }
  }
  
  sliceAndDice(sorted, 0, 0, arenaSize, arenaSize, true);
  return sectors;
}

// ═══════════════════════════════════════════════════════════════
// PHYSICS — серверная симуляция шайбы
// ═══════════════════════════════════════════════════════════════
function initPuck(rng) {
  const margin = CONFIG.ARENA_SIZE * 0.2;
  const x = margin + rng() * (CONFIG.ARENA_SIZE - 2 * margin);
  const y = margin + rng() * (CONFIG.ARENA_SIZE - 2 * margin);
  
  // Случайный угол импульса
  const angle = rng() * Math.PI * 2;
  // Скорость от 15 до 25
  const speed = 15 + rng() * 10;
  
  return {
    x, y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    radius: CONFIG.PUCK_RADIUS,
    spinAngle: 0,         // текущий угол стрелки-спиннера
    spinSpeed: 0,         // скорость вращения стрелки
    impulsAngle: angle,   // направление импульса (показывается стрелкой)
    launched: false,
  };
}

function stepPhysics(puck) {
  if (!puck || !puck.launched) return puck;
  
  const size = CONFIG.ARENA_SIZE;
  const r = puck.radius;
  
  // Обновляем позицию
  puck.x += puck.vx;
  puck.y += puck.vy;
  
  // Отскоки от стен
  if (puck.x - r <= 0) {
    puck.x = r;
    puck.vx = Math.abs(puck.vx) * 0.95;
  }
  if (puck.x + r >= size) {
    puck.x = size - r;
    puck.vx = -Math.abs(puck.vx) * 0.95;
  }
  if (puck.y - r <= 0) {
    puck.y = r;
    puck.vy = Math.abs(puck.vy) * 0.95;
  }
  if (puck.y + r >= size) {
    puck.y = size - r;
    puck.vy = -Math.abs(puck.vy) * 0.95;
  }
  
  // Трение
  puck.vx *= CONFIG.PUCK_FRICTION;
  puck.vy *= CONFIG.PUCK_FRICTION;
  
  // Вращение шайбы (визуальное)
  const speed = Math.sqrt(puck.vx * puck.vx + puck.vy * puck.vy);
  puck.spinAngle += speed * 0.05;
  
  return puck;
}

function isPuckStopped(puck) {
  if (!puck) return true;
  const speed = Math.sqrt(puck.vx * puck.vx + puck.vy * puck.vy);
  return speed < CONFIG.PUCK_MIN_SPEED;
}

function findWinnerSector(puck, sectors) {
  if (!puck || sectors.length === 0) return null;
  for (const s of sectors) {
    if (puck.x >= s.x && puck.x <= s.x + s.w &&
        puck.y >= s.y && puck.y <= s.y + s.h) {
      return s;
    }
  }
  // Fallback — ближайший сектор
  let minDist = Infinity;
  let closest = sectors[0];
  for (const s of sectors) {
    const dx = puck.x - s.cx;
    const dy = puck.y - s.cy;
    const dist = dx * dx + dy * dy;
    if (dist < minDist) { minDist = dist; closest = s; }
  }
  return closest;
}

// ═══════════════════════════════════════════════════════════════
// BOT SYSTEM — умные боты с кластерами
// ═══════════════════════════════════════════════════════════════
const BOT_NAMES = [
  '@cryptowolf', '@moonshot', '@diamond_hands', '@whale_alert', '@degen_king',
  '@ton_maxi', '@hodler42', '@nft_queen', '@alpha_hunter', '@block_wizard',
  '@satoshi_jr', '@pump_master', '@chain_smoker', '@gas_fee', '@rug_check',
  '@yield_farm', '@stake_pool', '@swap_lord', '@bridge_troll', '@dao_voter',
  '@meta_verse', '@pixel_punk', '@ape_strong', '@bear_trap', '@bull_run',
  'Grey Oscar', 'Anna K.', 'Max Power', 'Luna Star', 'Crypto Ninja',
  'Блокчейн Бро', 'ТОН Мастер', 'Кит Моби', 'Алмазные Руки', 'Король Дегенов',
];

const BOT_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
  '#F0B27A', '#82E0AA', '#F1948A', '#85929E', '#73C6B6',
  '#E74C3C', '#3498DB', '#2ECC71', '#F39C12', '#9B59B6',
  '#1ABC9C', '#E67E22', '#34495E', '#E91E63', '#00BCD4',
  '#FF9800', '#8BC34A', '#FF5722', '#607D8B', '#795548',
  '#FF69B4', '#00CED1',
];

const BOT_AVATARS = [
  null, null, null, null, null, // будут использоваться initials
];

function getInitials(name) {
  if (name.startsWith('@')) {
    return name.substring(1, 3).toUpperCase();
  }
  const parts = name.split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

// Определяем уровень активности по времени МСК
function getMSKActivityLevel() {
  const now = new Date();
  const mskHour = (now.getUTCHours() + 3) % 24;
  
  if (mskHour >= 2 && mskHour < 7) return 'night';      // 2-7: ночь
  if (mskHour >= 7 && mskHour < 12) return 'morning';    // 7-12: утро
  if (mskHour >= 12 && mskHour < 17) return 'day';       // 12-17: день
  if (mskHour >= 17 && mskHour < 23) return 'primetime';  // 17-23: прайм
  return 'latenight';                                      // 23-2: поздний вечер
}

function getActivityConfig(level) {
  const configs = {
    night:     { minBots: 2,  maxBots: 5,  whaleChance: 0.002, sharkChance: 0.02 },
    morning:   { minBots: 3,  maxBots: 8,  whaleChance: 0.005, sharkChance: 0.05 },
    day:       { minBots: 4,  maxBots: 12, whaleChance: 0.008, sharkChance: 0.08 },
    primetime: { minBots: 6,  maxBots: 20, whaleChance: 0.015, sharkChance: 0.12 },
    latenight: { minBots: 3,  maxBots: 8,  whaleChance: 0.005, sharkChance: 0.04 },
  };
  return configs[level] || configs.day;
}

let usedBotNames = new Set();
let roundCounter = 0;

function generateBotBet(cluster) {
  const ranges = {
    mass:  { min: 0.1, max: 10 },
    mid:   { min: 10, max: 100 },
    shark: { min: 100, max: 1000 },
    whale: { min: 1000, max: 10000 },
  };
  const range = ranges[cluster];
  // Логарифмическое распределение для естественности
  const logMin = Math.log(range.min);
  const logMax = Math.log(range.max);
  const bet = Math.exp(logMin + Math.random() * (logMax - logMin));
  return Math.round(bet * 100) / 100; // до 2 знаков
}

function pickBotName() {
  const available = BOT_NAMES.filter(n => !usedBotNames.has(n));
  if (available.length === 0) {
    usedBotNames.clear();
    return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
  }
  const name = available[Math.floor(Math.random() * available.length)];
  usedBotNames.add(name);
  return name;
}

function scheduleBots() {
  const activity = getMSKActivityLevel();
  const config = getActivityConfig(activity);
  roundCounter++;
  
  const numBots = config.minBots + Math.floor(Math.random() * (config.maxBots - config.minBots + 1));
  const bots = [];
  
  for (let i = 0; i < numBots; i++) {
    let cluster = 'mass';
    const roll = Math.random();
    
    // Кит — редкое событие (раз в 50-200 игр)
    if (roll < config.whaleChance && roundCounter % (50 + Math.floor(Math.random() * 150)) === 0) {
      cluster = 'whale';
    } else if (roll < config.sharkChance) {
      cluster = 'shark';
    } else if (roll < config.sharkChance + 0.25) {
      cluster = 'mid';
    }
    
    const name = pickBotName();
    const bet = generateBotBet(cluster);
    const colorIndex = Math.floor(Math.random() * BOT_COLORS.length);
    
    // Тайминг ставки: эффект снайпера для крупных
    let delay;
    if (cluster === 'whale' || cluster === 'shark') {
      // Последние 1-3 секунды
      delay = (CONFIG.TIMER_DURATION - 3 + Math.random() * 2.5) * 1000;
    } else if (cluster === 'mid') {
      // 5-10 секунд
      delay = (5 + Math.random() * 5) * 1000;
    } else {
      // Хаотично по всему таймеру
      delay = Math.random() * (CONFIG.TIMER_DURATION - 1) * 1000;
    }
    
    bots.push({ name, bet, color: BOT_COLORS[colorIndex], cluster, delay });
  }
  
  return bots;
}

// ═══════════════════════════════════════════════════════════════
// GAME LOOP — управление фазами
// ═══════════════════════════════════════════════════════════════
function resetRound() {
  gameState.roundId++;
  gameState.phase = 'waiting';
  gameState.players = [];
  gameState.totalPool = 0;
  gameState.timer = CONFIG.TIMER_DURATION;
  gameState.puck = null;
  gameState.sectors = [];
  gameState.winner = null;
  gameState.serverSeed = generateServerSeed();
  gameState.publicSeed = generatePublicSeed();
  gameState.seedHash = hashSeed(gameState.serverSeed);
  usedBotNames.clear();
  
  broadcastState();
  
  // Первый бот ставит через 1-3 секунды
  setTimeout(() => {
    if (gameState.phase === 'waiting' && gameState.players.length === 0) {
      addBotBet();
    }
  }, 1000 + Math.random() * 2000);
}

function addBotBet() {
  if (gameState.players.length >= CONFIG.MAX_PLAYERS) return;
  if (gameState.phase !== 'waiting' && gameState.phase !== 'countdown') return;
  
  const name = pickBotName();
  const cluster = Math.random() < 0.7 ? 'mass' : 'mid';
  const bet = generateBotBet(cluster);
  const colorIndex = gameState.players.length % BOT_COLORS.length;
  
  addPlayer({
    id: 'bot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    name,
    initials: getInitials(name),
    avatar: null,
    bet,
    color: BOT_COLORS[colorIndex],
    isBot: true,
  });
}

function addPlayer(player) {
  if (gameState.players.length >= CONFIG.MAX_PLAYERS) return false;
  if (gameState.phase === 'live' || gameState.phase === 'spinning' || 
      gameState.phase === 'result' || gameState.phase === 'paused') return false;
  
  gameState.players.push(player);
  gameState.totalPool = gameState.players.reduce((s, p) => s + p.bet, 0);
  gameState.totalPool = Math.round(gameState.totalPool * 100) / 100;
  gameState.sectors = calculateSectors(gameState.players, gameState.totalPool, CONFIG.ARENA_SIZE);
  
  // Если >=2 игрока и ещё не запущен таймер — запускаем
  if (gameState.players.length >= 2 && gameState.phase === 'waiting') {
    startCountdown();
  }
  
  broadcastState();
  return true;
}

function startCountdown() {
  gameState.phase = 'countdown';
  gameState.timer = CONFIG.TIMER_DURATION;
  
  // Планируем ботов на этот раунд
  const scheduledBots = scheduleBots();
  
  scheduledBots.forEach(bot => {
    setTimeout(() => {
      if (gameState.phase !== 'countdown') return;
      if (gameState.players.length >= CONFIG.MAX_PLAYERS) return;
      
      const colorIndex = gameState.players.length % BOT_COLORS.length;
      addPlayer({
        id: 'bot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        name: bot.name,
        initials: getInitials(bot.name),
        avatar: null,
        bet: bot.bet,
        color: bot.color,
        isBot: true,
      });
    }, bot.delay);
  });
  
  // Тикаем таймер
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    gameState.timer -= 1;
    
    if (gameState.timer <= 0) {
      clearInterval(timerInterval);
      startSpinning();
    }
    
    broadcastState();
  }, 1000);
}

function startSpinning() {
  gameState.phase = 'spinning';
  
  // Создаём PRNG из комбинации seeds
  const combinedSeed = gameState.serverSeed + gameState.publicSeed;
  const rng = seededRandom(combinedSeed);
  
  gameState.puck = initPuck(rng);
  broadcastState();
  
  // Раскрутка 2 секунды, потом импульс
  setTimeout(() => {
    if (gameState.puck) {
      gameState.puck.launched = true;
      gameState.phase = 'live';
      broadcastState();
      startPhysicsLoop();
    }
  }, CONFIG.SPIN_DURATION);
}

function startPhysicsLoop() {
  const interval = 1000 / CONFIG.PHYSICS_FPS;
  let frameCount = 0;
  
  clearInterval(physicsInterval);
  physicsInterval = setInterval(() => {
    if (!gameState.puck) {
      clearInterval(physicsInterval);
      return;
    }
    
    gameState.puck = stepPhysics(gameState.puck);
    frameCount++;
    
    // Отправляем позицию каждые 2 кадра (30 раз в секунду)
    if (frameCount % 2 === 0) {
      io.emit('puck_update', {
        x: gameState.puck.x,
        y: gameState.puck.y,
        vx: gameState.puck.vx,
        vy: gameState.puck.vy,
        spinAngle: gameState.puck.spinAngle,
      });
    }
    
    // Проверяем остановку
    if (isPuckStopped(gameState.puck)) {
      clearInterval(physicsInterval);
      endRound();
    }
  }, interval);
}

function endRound() {
  gameState.phase = 'result';
  
  const winnerSector = findWinnerSector(gameState.puck, gameState.sectors);
  if (winnerSector) {
    const winAmount = Math.round(gameState.totalPool * (1 - CONFIG.COMMISSION) * 100) / 100;
    const player = gameState.players.find(p => p.id === winnerSector.playerId);
    const multiplier = player ? Math.round((winAmount / player.bet) * 100) / 100 : 1;
    
    gameState.winner = {
      name: winnerSector.name,
      initials: winnerSector.initials,
      color: winnerSector.color,
      amount: winAmount,
      bet: winnerSector.bet,
      multiplier,
      sectorId: winnerSector.playerId,
    };
    
    // Обновляем рекорды
    if (winAmount > gameState.topGame.amount) {
      gameState.topGame = { name: winnerSector.name, initials: winnerSector.initials, amount: winAmount };
    }
    gameState.lastGame = { name: winnerSector.name, initials: winnerSector.initials, amount: Math.round((winAmount - winnerSector.bet) * 100) / 100 };
  }
  
  broadcastState();
  
  // Пауза, потом новый раунд
  setTimeout(() => {
    gameState.phase = 'paused';
    broadcastState();
    
    setTimeout(() => {
      resetRound();
    }, CONFIG.PAUSE_BETWEEN);
  }, CONFIG.RESULT_DISPLAY);
}

// ═══════════════════════════════════════════════════════════════
// BROADCAST — отправка состояния клиентам
// ═══════════════════════════════════════════════════════════════
function broadcastState() {
  // Отправляем без серверного сида (для честности)
  const clientState = {
    phase: gameState.phase,
    roundId: gameState.roundId,
    players: gameState.players.map(p => ({
      id: p.id,
      name: p.name,
      initials: p.initials,
      avatar: p.avatar,
      bet: p.bet,
      color: p.color,
    })),
    totalPool: gameState.totalPool,
    timer: gameState.timer,
    seedHash: gameState.seedHash,
    sectors: gameState.sectors,
    puck: gameState.puck ? {
      x: gameState.puck.x,
      y: gameState.puck.y,
      vx: gameState.puck.vx,
      vy: gameState.puck.vy,
      spinAngle: gameState.puck.spinAngle,
      impulsAngle: gameState.puck.impulsAngle,
      launched: gameState.puck.launched,
      radius: gameState.puck.radius,
    } : null,
    winner: gameState.winner,
    topGame: gameState.topGame,
    lastGame: gameState.lastGame,
  };
  
  io.emit('game_state', clientState);
}

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO — обработка подключений
// ═══════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[+] Player connected: ${socket.id}`);
  
  // Отправляем текущее состояние новому игроку
  broadcastState();
  
  // Игрок делает ставку
  socket.on('place_bet', (data) => {
    const { name, bet, avatar } = data;
    
    // Валидация
    if (!name || typeof name !== 'string' || name.length > 30) {
      socket.emit('error', { message: 'Неверное имя' });
      return;
    }
    if (typeof bet !== 'number' || bet < CONFIG.MIN_BET || bet > CONFIG.MAX_BET) {
      socket.emit('error', { message: `Ставка от ${CONFIG.MIN_BET} до ${CONFIG.MAX_BET} TON` });
      return;
    }
    if (gameState.phase === 'live' || gameState.phase === 'spinning' || 
        gameState.phase === 'result' || gameState.phase === 'paused') {
      socket.emit('error', { message: 'Раунд уже идёт, ждите следующий' });
      return;
    }
    if (gameState.players.length >= CONFIG.MAX_PLAYERS) {
      socket.emit('error', { message: 'Все слоты заняты' });
      return;
    }
    // Проверяем, не ставил ли уже этот сокет
    if (gameState.players.find(p => p.id === socket.id)) {
      socket.emit('error', { message: 'Вы уже в этом раунде' });
      return;
    }
    
    const colorIndex = gameState.players.length % BOT_COLORS.length;
    const success = addPlayer({
      id: socket.id,
      name: name.substring(0, 20),
      initials: getInitials(name),
      avatar: avatar || null,
      bet: Math.round(bet * 100) / 100,
      color: BOT_COLORS[colorIndex],
      isBot: false,
    });
    
    if (success) {
      socket.emit('bet_accepted', { bet: Math.round(bet * 100) / 100 });
    }
  });
  
  socket.on('disconnect', () => {
    console.log(`[-] Player disconnected: ${socket.id}`);
  });
});

// ═══════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`\n🎰 Crypto Roulette Server running on port ${PORT}`);
  console.log(`📡 Open http://localhost:${PORT} in browser\n`);
  resetRound();
});
