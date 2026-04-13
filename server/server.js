// CRYPTO ROULETTE — Server v5
const express=require('express'),http=require('http'),{Server}=require('socket.io'),cors=require('cors'),crypto=require('crypto'),path=require('path');
const app=express();app.use(cors());app.use(express.static(path.join(__dirname,'..','client')));
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:'*',methods:['GET','POST']}});
const PORT=process.env.PORT||3000;

const CONFIG={MAX_PLAYERS:32,TIMER_DURATION:15,COMMISSION:0.15,MIN_BET:0.1,MAX_BET:999999.99,BOT_MAX_BET:50000,
  ARENA_SIZE:600,PUCK_RADIUS:16,PUCK_FRICTION:0.991,PUCK_MIN_SPEED:0.25,PHYSICS_FPS:60,
  SPIN_DURATION:3500,RESULT_DISPLAY:4000,PAUSE_BETWEEN:3000,INITIAL_BALANCE:1000};

function genSeed(){return crypto.randomBytes(32).toString('hex');}
function genPub(){return crypto.randomBytes(16).toString('hex');}
function hashS(s){return crypto.createHash('sha256').update(s).digest('hex');}
function sRng(seed){let h=0;for(let i=0;i<seed.length;i++)h=((h<<5)-h+seed.charCodeAt(i))|0;return()=>{h=(h*1103515245+12345)&0x7fffffff;return h/0x7fffffff;};}

const playerBalances=new Map(),playerNames=new Map();

let GS={phase:'waiting',roundId:0,players:[],totalPool:0,timer:CONFIG.TIMER_DURATION,
  serverSeed:null,publicSeed:null,seedHash:null,puck:null,sectors:[],winner:null,
  topGame:{name:'—',initials:'—',amount:0},lastGame:{name:'—',initials:'—',amount:0}};
let timerI=null,physicsI=null;

// Treemap
function calcSectors(pl,tp,sz){
  if(!pl.length)return[];const sec=[],so=[...pl].sort((a,b)=>b.bet-a.bet);
  function sq(it,x,y,w,h){
    if(!it.length)return;
    if(it.length===1){const p=it[0];sec.push({playerId:p.id,name:p.name,avatar:p.avatar,initials:p.initials,color:p.color,bet:p.bet,percent:(p.bet/tp*100).toFixed(1),x,y,w,h,cx:x+w/2,cy:y+h/2});return;}
    const tv=it.reduce((s,p)=>s+p.bet,0),vt=w>=h;let br=[it[0]],brt=Infinity;
    for(let i=0;i<it.length;i++){const rw=it.slice(0,i+1),rv=rw.reduce((s,p)=>s+p.bet,0),rf=rv/tv,st=vt?w*rf:h*rf;
      let wst=0;for(const p of rw){const pf=p.bet/rv;const cw=vt?st:w*pf,ch=vt?h*pf:st;wst=Math.max(wst,Math.max(cw/Math.max(ch,.1),ch/Math.max(cw,.1)));}
      if(wst<=brt||i===0){brt=wst;br=rw;}else break;}
    const rv=br.reduce((s,p)=>s+p.bet,0),st=vt?w*(rv/tv):h*(rv/tv);let off=0;
    for(const p of br){const pf=p.bet/rv,cl=vt?h*pf:w*pf;const sx=vt?x:x+off,sy=vt?y+off:y,sw=vt?st:cl,sh=vt?cl:st;
      sec.push({playerId:p.id,name:p.name,avatar:p.avatar,initials:p.initials,color:p.color,bet:p.bet,percent:(p.bet/tp*100).toFixed(1),x:sx,y:sy,w:sw,h:sh,cx:sx+sw/2,cy:sy+sh/2});off+=cl;}
    const rest=it.slice(br.length);if(rest.length){if(vt)sq(rest,x+st,y,w-st,h);else sq(rest,x,y+st,w,h-st);}
  }
  sq(so,0,0,sz,sz);return sec;
}

// Physics
function initPuck(rng){const m=CONFIG.ARENA_SIZE*.2,x=m+rng()*(CONFIG.ARENA_SIZE-2*m),y=m+rng()*(CONFIG.ARENA_SIZE-2*m),a=rng()*Math.PI*2,sp=24+rng()*12;
  return{x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,radius:CONFIG.PUCK_RADIUS,spinAngle:0,impulsAngle:a,launched:false};}
function stepP(p){if(!p||!p.launched)return p;const s=CONFIG.ARENA_SIZE,r=p.radius;p.x+=p.vx;p.y+=p.vy;
  if(p.x-r<=0){p.x=r;p.vx=Math.abs(p.vx)*.96;}if(p.x+r>=s){p.x=s-r;p.vx=-Math.abs(p.vx)*.96;}
  if(p.y-r<=0){p.y=r;p.vy=Math.abs(p.vy)*.96;}if(p.y+r>=s){p.y=s-r;p.vy=-Math.abs(p.vy)*.96;}
  p.vx*=CONFIG.PUCK_FRICTION;p.vy*=CONFIG.PUCK_FRICTION;p.spinAngle+=Math.sqrt(p.vx**2+p.vy**2)*.05;return p;}
function stopped(p){return!p||Math.sqrt(p.vx**2+p.vy**2)<CONFIG.PUCK_MIN_SPEED;}
function findW(pk,sec){if(!pk||!sec.length)return null;for(const s of sec)if(pk.x>=s.x&&pk.x<=s.x+s.w&&pk.y>=s.y&&pk.y<=s.y+s.h)return s;
  let mn=Infinity,c=sec[0];for(const s of sec){const d=(pk.x-s.cx)**2+(pk.y-s.cy)**2;if(d<mn){mn=d;c=s;}}return c;}

// Bots
const BN=['@cryptowolf','@moonshot','@diamond_hands','@whale_alert','@degen_king','@ton_maxi','@hodler42','@nft_queen','@alpha_hunter','@block_wizard',
  '@satoshi_jr','@pump_master','@chain_smoker','@gas_fee','@rug_check','@yield_farm','@stake_pool','@swap_lord','@bridge_troll','@dao_voter',
  '@meta_verse','@pixel_punk','@ape_strong','@bear_trap','@bull_run','Grey Oscar','Anna K.','Max Power','Luna Star','Crypto Ninja',
  'Блокчейн Бро','ТОН Мастер','Кит Моби','Алмазные Руки','Король Дегенов'];
const BC=['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9','#F0B27A','#82E0AA','#F1948A','#85929E','#73C6B6','#E74C3C','#3498DB','#2ECC71','#F39C12','#9B59B6','#1ABC9C','#E67E22','#34495E','#E91E63','#00BCD4','#FF9800','#8BC34A','#FF5722','#607D8B','#795548','#FF69B4','#00CED1'];
function gI(n){if(n.startsWith('@'))return n.substring(1,3).toUpperCase();const p=n.split(/[\s.]+/).filter(Boolean);return p.length>=2?(p[0][0]+p[1][0]).toUpperCase():n.substring(0,2).toUpperCase();}
let ubn=new Set(),rc=0;
function gBB(c){const r={mass:[0.1,10],mid:[10,100],shark:[100,1000],whale:[1000,50000]}[c];return Math.round(Math.exp(Math.log(r[0])+Math.random()*(Math.log(r[1])-Math.log(r[0])))*100)/100;}
function pB(){let a=BN.filter(n=>!ubn.has(n));if(!a.length){ubn.clear();a=BN;}const n=a[Math.floor(Math.random()*a.length)];ubn.add(n);return n;}
function sB(){const h=(new Date().getUTCHours()+3)%24;let cfg;
  if(h>=2&&h<7)cfg={min:2,max:5,sc:.02};else if(h>=17&&h<23)cfg={min:6,max:20,sc:.12};else cfg={min:3,max:10,sc:.06};
  rc++;const num=cfg.min+Math.floor(Math.random()*(cfg.max-cfg.min+1)),bots=[];
  for(let i=0;i<num;i++){let cl='mass';const r=Math.random();
    if(r<.003&&rc%80===0)cl='whale';else if(r<cfg.sc)cl='shark';else if(r<cfg.sc+.25)cl='mid';
    let d;if(cl==='whale'||cl==='shark')d=(CONFIG.TIMER_DURATION-3+Math.random()*2.5)*1000;
    else if(cl==='mid')d=(5+Math.random()*5)*1000;else d=Math.random()*(CONFIG.TIMER_DURATION-1)*1000;
    bots.push({name:pB(),bet:gBB(cl),color:BC[Math.floor(Math.random()*BC.length)],delay:d});}
  return bots;}

// Game Loop
function reset(){GS.roundId++;GS.phase='waiting';GS.players=[];GS.totalPool=0;GS.timer=CONFIG.TIMER_DURATION;
  GS.puck=null;GS.sectors=[];GS.winner=null;GS.serverSeed=genSeed();GS.publicSeed=genPub();
  GS.seedHash=hashS(GS.serverSeed);ubn.clear();broadcast();
  setTimeout(()=>{if(GS.phase==='waiting'){aBB();setTimeout(()=>{if(GS.phase==='waiting')aBB();},1000+Math.random()*1000);}},1000+Math.random()*2000);}

function aBB(){if(GS.players.length>=CONFIG.MAX_PLAYERS||!['waiting','countdown'].includes(GS.phase))return;
  const n=pB(),cl=Math.random()<.7?'mass':'mid';
  addP({id:'bot_'+Date.now()+'_'+Math.random().toString(36).substr(2,5),name:n,initials:gI(n),avatar:null,bet:gBB(cl),color:BC[GS.players.length%BC.length],isBot:true});}

function addP(p){if(GS.players.length>=CONFIG.MAX_PLAYERS||['live','spinning','result','paused'].includes(GS.phase))return false;
  GS.players.push(p);GS.totalPool=Math.round(GS.players.reduce((s,p)=>s+p.bet,0)*100)/100;
  GS.sectors=calcSectors(GS.players,GS.totalPool,CONFIG.ARENA_SIZE);
  if(GS.players.length>=2&&GS.phase==='waiting')startCD();broadcast();return true;}

function startCD(){GS.phase='countdown';GS.timer=CONFIG.TIMER_DURATION;
  sB().forEach(b=>{setTimeout(()=>{if(GS.phase!=='countdown'||GS.players.length>=CONFIG.MAX_PLAYERS)return;
    addP({id:'bot_'+Date.now()+'_'+Math.random().toString(36).substr(2,5),name:b.name,initials:gI(b.name),avatar:null,bet:b.bet,color:b.color,isBot:true});},b.delay);});
  clearInterval(timerI);timerI=setInterval(()=>{GS.timer--;if(GS.timer<=0){clearInterval(timerI);startSpin();}broadcast();},1000);}

function startSpin(){GS.phase='spinning';GS.puck=initPuck(sRng(GS.serverSeed+GS.publicSeed));broadcast();
  setTimeout(()=>{if(GS.puck){GS.puck.launched=true;GS.phase='live';broadcast();startPhys();}},CONFIG.SPIN_DURATION);}

function startPhys(){let fc=0;clearInterval(physicsI);
  physicsI=setInterval(()=>{if(!GS.puck){clearInterval(physicsI);return;}GS.puck=stepP(GS.puck);fc++;
    if(fc%2===0)io.emit('puck_update',{x:GS.puck.x,y:GS.puck.y,vx:GS.puck.vx,vy:GS.puck.vy,spinAngle:GS.puck.spinAngle});
    if(stopped(GS.puck)){clearInterval(physicsI);endRound();}},1000/CONFIG.PHYSICS_FPS);}

function endRound(){GS.phase='result';const ws=findW(GS.puck,GS.sectors);
  if(ws){const p=GS.players.find(pl=>pl.id===ws.playerId);const bet=p?p.bet:0;
    const np=GS.totalPool-bet,comm=Math.round(np*CONFIG.COMMISSION*100)/100;
    const wa=Math.round((GS.totalPool-comm)*100)/100,prof=Math.round((wa-bet)*100)/100;
    const mult=bet>0?Math.round((wa/bet)*100)/100:1,pct=bet>0?(bet/GS.totalPool*100).toFixed(1):'0';
    GS.winner={name:ws.name,initials:ws.initials,color:ws.color,amount:wa,bet,multiplier:mult,profit:prof,percent:pct,sectorId:ws.playerId};
    if(!ws.playerId.startsWith('bot_')&&playerBalances.has(ws.playerId)){
      const nb=Math.round((playerBalances.get(ws.playerId)+wa)*100)/100;playerBalances.set(ws.playerId,nb);
      io.to(ws.playerId).emit('balance_update',{balance:nb});}
    if(wa>GS.topGame.amount)GS.topGame={name:ws.name,initials:ws.initials,amount:wa};
    GS.lastGame={name:ws.name,initials:ws.initials,amount:prof};}
  broadcast();setTimeout(()=>{GS.phase='paused';broadcast();setTimeout(reset,CONFIG.PAUSE_BETWEEN);},CONFIG.RESULT_DISPLAY);}

function broadcast(){io.emit('game_state',{phase:GS.phase,roundId:GS.roundId,
  players:GS.players.map(p=>({id:p.id,name:p.name,initials:p.initials,avatar:p.avatar,bet:p.bet,color:p.color})),
  totalPool:GS.totalPool,timer:GS.timer,seedHash:GS.seedHash,sectors:GS.sectors,
  puck:GS.puck?{x:GS.puck.x,y:GS.puck.y,vx:GS.puck.vx,vy:GS.puck.vy,spinAngle:GS.puck.spinAngle,impulsAngle:GS.puck.impulsAngle,launched:GS.puck.launched,radius:GS.puck.radius}:null,
  winner:GS.winner,topGame:GS.topGame,lastGame:GS.lastGame});}

io.on('connection',socket=>{
  console.log(`[+] ${socket.id}`);

  // Восстановление баланса от клиента
  socket.on('restore_balance',data=>{
    if(typeof data.balance==='number'&&data.balance>=0&&!playerBalances.has(socket.id)){
      playerBalances.set(socket.id,Math.round(data.balance*100)/100);
    }
    if(!playerBalances.has(socket.id))playerBalances.set(socket.id,CONFIG.INITIAL_BALANCE);
    socket.emit('balance_update',{balance:playerBalances.get(socket.id)});
  });

  if(!playerBalances.has(socket.id))playerBalances.set(socket.id,CONFIG.INITIAL_BALANCE);
  socket.emit('balance_update',{balance:playerBalances.get(socket.id)});
  broadcast();

  socket.on('place_bet',data=>{
    const{name,bet,avatar}=data;
    if(!name||typeof name!=='string'||name.length>30)return socket.emit('error',{message:'Неверное имя'});
    const ba=Math.round(parseFloat(bet)*100)/100;
    if(isNaN(ba)||ba<CONFIG.MIN_BET||ba>CONFIG.MAX_BET)return socket.emit('error',{message:`Ставка от ${CONFIG.MIN_BET} до ${CONFIG.MAX_BET} TON`});
    if(['live','spinning','result','paused'].includes(GS.phase))return socket.emit('error',{message:'Ждите следующий раунд'});
    if(GS.players.length>=CONFIG.MAX_PLAYERS)return socket.emit('error',{message:'Все слоты заняты'});
    if(GS.players.find(p=>p.id===socket.id))return socket.emit('error',{message:'Вы уже в раунде'});
    const bal=playerBalances.get(socket.id)||0;
    if(ba>bal)return socket.emit('error',{message:`Недостаточно. Баланс: ${bal} TON`});
    playerBalances.set(socket.id,Math.round((bal-ba)*100)/100);
    socket.emit('balance_update',{balance:playerBalances.get(socket.id)});
    playerNames.set(socket.id,name.substring(0,20));
    const ok=addP({id:socket.id,name:name.substring(0,20),initials:gI(name),avatar:avatar||null,bet:ba,color:BC[GS.players.length%BC.length],isBot:false});
    if(ok)socket.emit('bet_accepted',{bet:ba});
    else{playerBalances.set(socket.id,Math.round((playerBalances.get(socket.id)+ba)*100)/100);socket.emit('balance_update',{balance:playerBalances.get(socket.id)});}
  });
  socket.on('disconnect',()=>console.log(`[-] ${socket.id}`));
});

server.listen(PORT,()=>{console.log(`\n🎰 Roulette v5 :${PORT}\n`);reset();});