// CRYPTO ROULETTE — Server v6
const express=require('express'),http=require('http'),{Server}=require('socket.io'),cors=require('cors'),crypto=require('crypto'),path=require('path');
const app=express();app.use(cors());app.use(express.static(path.join(__dirname,'..','client')));
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:'*',methods:['GET','POST']}});
const PORT=process.env.PORT||3000;

const C={MAX_PLAYERS:32,TIMER_DURATION:15,COMMISSION:0.15,MIN_BET:0.1,MAX_BET:999999.99,
  ARENA:600,PUCK_R:16,FRIC:0.991,MIN_SP:0.25,FPS:60,
  SPIN_DUR:3500,RES_DUR:4500,PAUSE:3000,INIT_BAL:1000};

function genS(){return crypto.randomBytes(32).toString('hex');}
function genP(){return crypto.randomBytes(16).toString('hex');}
function hashS(s){return crypto.createHash('sha256').update(s).digest('hex');}
function sR(seed){let h=0;for(let i=0;i<seed.length;i++)h=((h<<5)-h+seed.charCodeAt(i))|0;return()=>{h=(h*1103515245+12345)&0x7fffffff;return h/0x7fffffff;};}

const pBal=new Map(),pNam=new Map();

let G={phase:'waiting',rid:0,players:[],pool:0,timer:C.TIMER_DURATION,
  sSeed:null,pSeed:null,sHash:null,puck:null,sectors:[],winner:null,
  top:{name:'—',ini:'—',amt:0},last:{name:'—',ini:'—',amt:0}};
let tI=null,phI=null;

function calcSec(pl,tp,sz){
  if(!pl.length)return[];const sec=[],so=[...pl].sort((a,b)=>b.bet-a.bet);
  function sq(it,x,y,w,h){if(!it.length)return;
    if(it.length===1){const p=it[0];sec.push({pid:p.id,name:p.name,ini:p.ini,color:p.color,bet:p.bet,pct:(p.bet/tp*100).toFixed(1),x,y,w,h,cx:x+w/2,cy:y+h/2});return;}
    const tv=it.reduce((s,p)=>s+p.bet,0),vt=w>=h;let br=[it[0]],brt=Infinity;
    for(let i=0;i<it.length;i++){const rw=it.slice(0,i+1),rv=rw.reduce((s,p)=>s+p.bet,0),rf=rv/tv,st=vt?w*rf:h*rf;
      let wst=0;for(const p of rw){const pf=p.bet/rv;const cw=vt?st:w*pf,ch=vt?h*pf:st;wst=Math.max(wst,Math.max(cw/Math.max(ch,.1),ch/Math.max(cw,.1)));}
      if(wst<=brt||i===0){brt=wst;br=rw;}else break;}
    const rv=br.reduce((s,p)=>s+p.bet,0),st=vt?w*(rv/tv):h*(rv/tv);let off=0;
    for(const p of br){const pf=p.bet/rv,cl=vt?h*pf:w*pf;const sx=vt?x:x+off,sy=vt?y+off:y,sw=vt?st:cl,sh=vt?cl:st;
      sec.push({pid:p.id,name:p.name,ini:p.ini,color:p.color,bet:p.bet,pct:(p.bet/tp*100).toFixed(1),x:sx,y:sy,w:sw,h:sh,cx:sx+sw/2,cy:sy+sh/2});off+=cl;}
    const rest=it.slice(br.length);if(rest.length){if(vt)sq(rest,x+st,y,w-st,h);else sq(rest,x,y+st,w,h-st);}}
  sq(so,0,0,sz,sz);return sec;}

function initPk(rng){const m=C.ARENA*.2,x=m+rng()*(C.ARENA-2*m),y=m+rng()*(C.ARENA-2*m),a=rng()*Math.PI*2,sp=24+rng()*12;
  return{x,y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,r:C.PUCK_R,sa:0,ia:a,launched:false};}
function stepP(p){if(!p||!p.launched)return p;const s=C.ARENA,r=p.r;p.x+=p.vx;p.y+=p.vy;
  if(p.x-r<=0){p.x=r;p.vx=Math.abs(p.vx)*.96;}if(p.x+r>=s){p.x=s-r;p.vx=-Math.abs(p.vx)*.96;}
  if(p.y-r<=0){p.y=r;p.vy=Math.abs(p.vy)*.96;}if(p.y+r>=s){p.y=s-r;p.vy=-Math.abs(p.vy)*.96;}
  p.vx*=C.FRIC;p.vy*=C.FRIC;p.sa+=Math.sqrt(p.vx**2+p.vy**2)*.05;return p;}
function stopped(p){return!p||Math.sqrt(p.vx**2+p.vy**2)<C.MIN_SP;}
function findW(pk,sec){if(!pk||!sec.length)return null;for(const s of sec)if(pk.x>=s.x&&pk.x<=s.x+s.w&&pk.y>=s.y&&pk.y<=s.y+s.h)return s;
  let mn=Infinity,c=sec[0];for(const s of sec){const d=(pk.x-s.cx)**2+(pk.y-s.cy)**2;if(d<mn){mn=d;c=s;}}return c;}

const BN=['@cryptowolf','@moonshot','@diamond_hands','@whale_alert','@degen_king','@ton_maxi','@hodler42','@nft_queen','@alpha_hunter','@block_wizard',
  '@satoshi_jr','@pump_master','@chain_smoker','@gas_fee','@rug_check','@yield_farm','@stake_pool','@swap_lord','@bridge_troll','@dao_voter',
  '@meta_verse','@pixel_punk','@ape_strong','@bear_trap','@bull_run','Grey Oscar','Anna K.','Max Power','Luna Star','Crypto Ninja',
  'Блокчейн Бро','ТОН Мастер','Кит Моби','Алмазные Руки','Король Дегенов'];
const BC=['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9','#F0B27A','#82E0AA','#F1948A','#85929E','#73C6B6','#E74C3C','#3498DB','#2ECC71','#F39C12','#9B59B6','#1ABC9C','#E67E22','#34495E','#E91E63','#00BCD4','#FF9800','#8BC34A','#FF5722','#607D8B','#795548','#FF69B4','#00CED1'];
function gI(n){if(n.startsWith('@'))return n.substring(1,3).toUpperCase();const p=n.split(/[\s.]+/).filter(Boolean);return p.length>=2?(p[0][0]+p[1][0]).toUpperCase():n.substring(0,2).toUpperCase();}
let ubn=new Set(),rc=0;
function gBB(c){const r={mass:[0.1,10],mid:[10,100],shark:[100,1000],whale:[1000,50000]}[c];return Math.round(Math.exp(Math.log(r[0])+Math.random()*(Math.log(r[1])-Math.log(r[0])))*100)/100;}
function pBn(){let a=BN.filter(n=>!ubn.has(n));if(!a.length){ubn.clear();a=BN;}const n=a[Math.floor(Math.random()*a.length)];ubn.add(n);return n;}
function sB(){const h=(new Date().getUTCHours()+3)%24;let cfg;
  if(h>=2&&h<7)cfg={min:2,max:5,sc:.02};else if(h>=17&&h<23)cfg={min:6,max:20,sc:.12};else cfg={min:3,max:10,sc:.06};
  rc++;const num=cfg.min+Math.floor(Math.random()*(cfg.max-cfg.min+1)),bots=[];
  for(let i=0;i<num;i++){let cl='mass';const r=Math.random();
    if(r<.003&&rc%80===0)cl='whale';else if(r<cfg.sc)cl='shark';else if(r<cfg.sc+.25)cl='mid';
    let d;if(cl==='whale'||cl==='shark')d=(C.TIMER_DURATION-3+Math.random()*2.5)*1000;
    else if(cl==='mid')d=(5+Math.random()*5)*1000;else d=Math.random()*(C.TIMER_DURATION-1)*1000;
    bots.push({name:pBn(),bet:gBB(cl),color:BC[Math.floor(Math.random()*BC.length)],delay:d});}return bots;}

function recalc(){G.pool=Math.round(G.players.reduce((s,p)=>s+p.bet,0)*100)/100;G.sectors=calcSec(G.players,G.pool,C.ARENA);}

function reset(){G.rid++;G.phase='waiting';G.players=[];G.pool=0;G.timer=C.TIMER_DURATION;
  G.puck=null;G.sectors=[];G.winner=null;G.sSeed=genS();G.pSeed=genP();G.sHash=hashS(G.sSeed);ubn.clear();bcast();
  setTimeout(()=>{if(G.phase==='waiting'){aBB();setTimeout(()=>{if(G.phase==='waiting')aBB();},1000+Math.random()*1000);}},1000+Math.random()*2000);}

function aBB(){if(G.players.length>=C.MAX_PLAYERS||!['waiting','countdown'].includes(G.phase))return;
  const n=pBn(),cl=Math.random()<.7?'mass':'mid';
  addP({id:'bot_'+Date.now()+'_'+Math.random().toString(36).substr(2,5),name:n,ini:gI(n),bet:gBB(cl),color:BC[G.players.length%BC.length],isBot:true});}

function addP(p){if(G.players.length>=C.MAX_PLAYERS||['live','spinning','result','paused'].includes(G.phase))return false;
  G.players.push(p);recalc();if(G.players.length>=2&&G.phase==='waiting')startCD();bcast();return true;}

function startCD(){G.phase='countdown';G.timer=C.TIMER_DURATION;
  sB().forEach(b=>{setTimeout(()=>{if(G.phase!=='countdown'||G.players.length>=C.MAX_PLAYERS)return;
    addP({id:'bot_'+Date.now()+'_'+Math.random().toString(36).substr(2,5),name:b.name,ini:gI(b.name),bet:b.bet,color:b.color,isBot:true});},b.delay);});
  clearInterval(tI);tI=setInterval(()=>{G.timer--;if(G.timer<=0){clearInterval(tI);startSpin();}bcast();},1000);}

function startSpin(){G.phase='spinning';G.puck=initPk(sR(G.sSeed+G.pSeed));bcast();
  setTimeout(()=>{if(G.puck){G.puck.launched=true;G.phase='live';bcast();startPhys();}},C.SPIN_DUR);}

function startPhys(){let fc=0;clearInterval(phI);
  phI=setInterval(()=>{if(!G.puck){clearInterval(phI);return;}G.puck=stepP(G.puck);fc++;
    if(fc%2===0)io.emit('pu',{x:G.puck.x,y:G.puck.y,vx:G.puck.vx,vy:G.puck.vy});
    if(stopped(G.puck)){clearInterval(phI);endR();}},1000/C.FPS);}

function endR(){G.phase='result';const ws=findW(G.puck,G.sectors);
  if(ws){const p=G.players.find(pl=>pl.id===ws.pid);const bet=p?p.bet:0;
    const np=G.pool-bet,comm=Math.round(np*C.COMMISSION*100)/100;
    const wa=Math.round((G.pool-comm)*100)/100,prof=Math.round((wa-bet)*100)/100;
    const mult=bet>0?Math.round((wa/bet)*100)/100:1,pct=bet>0?(bet/G.pool*100).toFixed(1):'0';
    G.winner={name:ws.name,ini:ws.ini,color:ws.color,amt:wa,bet,mult,prof,pct,sid:ws.pid};
    if(!ws.pid.startsWith('bot_')&&pBal.has(ws.pid)){
      const nb=Math.round((pBal.get(ws.pid)+wa)*100)/100;pBal.set(ws.pid,nb);
      io.to(ws.pid).emit('bal',{b:nb});}
    if(wa>G.top.amt)G.top={name:ws.name,ini:ws.ini,amt:wa};
    G.last={name:ws.name,ini:ws.ini,amt:prof};}
  bcast();setTimeout(()=>{G.phase='paused';bcast();setTimeout(reset,C.PAUSE);},C.RES_DUR);}

function bcast(){io.emit('gs',{ph:G.phase,rid:G.rid,
  pl:G.players.map(p=>({id:p.id,name:p.name,ini:p.ini,bet:p.bet,color:p.color})),
  pool:G.pool,timer:G.timer,sh:G.sHash,sec:G.sectors,
  pk:G.puck?{x:G.puck.x,y:G.puck.y,vx:G.puck.vx,vy:G.puck.vy,ia:G.puck.ia,launched:G.puck.launched,r:G.puck.r}:null,
  w:G.winner,top:G.top,last:G.last});}

io.on('connection',sk=>{
  console.log(`[+] ${sk.id}`);
  sk.on('restore_bal',d=>{if(typeof d.b==='number'&&d.b>=0){pBal.set(sk.id,Math.round(d.b*100)/100);}
    if(!pBal.has(sk.id))pBal.set(sk.id,C.INIT_BAL);sk.emit('bal',{b:pBal.get(sk.id)});});
  if(!pBal.has(sk.id))pBal.set(sk.id,C.INIT_BAL);
  sk.emit('bal',{b:pBal.get(sk.id)});bcast();

  sk.on('bet',d=>{
    const{name,bet}=d;
    if(!name||typeof name!=='string')return sk.emit('err',{m:'Неверное имя'});
    const ba=Math.round(parseFloat(bet)*100)/100;
    if(isNaN(ba)||ba<C.MIN_BET||ba>C.MAX_BET)return sk.emit('err',{m:'Неверная ставка'});
    if(['live','spinning','result','paused'].includes(G.phase))return sk.emit('err',{m:'Ждите следующий раунд'});
    if(G.players.length>=C.MAX_PLAYERS&&!G.players.find(p=>p.id===sk.id))return sk.emit('err',{m:'Все слоты заняты'});
    const bal=pBal.get(sk.id)||0;
    if(ba>bal)return sk.emit('err',{m:`Недостаточно. Баланс: ${bal} TON`});

    // Списываем
    pBal.set(sk.id,Math.round((bal-ba)*100)/100);
    sk.emit('bal',{b:pBal.get(sk.id)});
    pNam.set(sk.id,name.substring(0,20));

    // Проверяем — уже есть ставка? Добавляем к ней
    const existing=G.players.find(p=>p.id===sk.id);
    if(existing){
      existing.bet=Math.round((existing.bet+ba)*100)/100;
      existing.name=name.substring(0,20);
      existing.ini=gI(name);
      recalc();bcast();
      sk.emit('bet_ok',{bet:existing.bet});
    }else{
      const ok=addP({id:sk.id,name:name.substring(0,20),ini:gI(name),bet:ba,color:BC[G.players.length%BC.length],isBot:false});
      if(ok)sk.emit('bet_ok',{bet:ba});
      else{pBal.set(sk.id,Math.round((pBal.get(sk.id)+ba)*100)/100);sk.emit('bal',{b:pBal.get(sk.id)});}
    }
  });
  sk.on('disconnect',()=>console.log(`[-] ${sk.id}`));
});

server.listen(PORT,()=>{console.log(`\n🎰 Roulette v6 :${PORT}\n`);reset();});