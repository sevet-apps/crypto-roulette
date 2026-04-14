// CRYPTO ROULETTE — Server v9
const express=require('express'),http=require('http'),{Server}=require('socket.io'),cors=require('cors'),crypto=require('crypto'),path=require('path');
const app=express();app.use(cors());app.use(express.json());app.use(express.static(path.join(__dirname,'..','client')));
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:'*',methods:['GET','POST']},maxHttpBufferSize:5e6});
const PORT=process.env.PORT||3000;
const OWNER_ID='lagaet'; // owner username without @
const C={MAX_PLAYERS:32,TIMER:15,COMM:0.15,MIN_BET:0.1,MAX_BET:999999.99,ARENA:600,PKR:16,FRIC:0.991,MIN_SP:0.25,
  SPIN:4500,RES:4500,PAUSE:3000,INIT_BAL:1000};

function genS(){return crypto.randomBytes(32).toString('hex');}function genP(){return crypto.randomBytes(16).toString('hex');}
function hashS(s){return crypto.createHash('sha256').update(s).digest('hex');}
function sR(seed){let h=0;for(let i=0;i<seed.length;i++)h=((h<<5)-h+seed.charCodeAt(i))|0;return()=>{h=(h*1103515245+12345)&0x7fffffff;return h/0x7fffffff;};}

// Balance store: username -> balance (persists across reconnects)
const balByUser=new Map(); // username -> {bal, lastDeposit}
const sockToUser=new Map(); // socketId -> username
const userToSock=new Map(); // username -> socketId

function getUserBal(username){
  if(!balByUser.has(username))balByUser.set(username,{bal:C.INIT_BAL,lastDep:0});
  return balByUser.get(username);
}

let G={ph:'waiting',rid:0,pl:[],pool:0,timer:C.TIMER,ss:null,ps:null,sh:null,winner:null,sectors:[],
  top:{name:'—',ini:'—',amt:0},last:{name:'—',ini:'—',amt:0},traj:null,trajAngle:0,puckSpawn:null};
let tI=null;

function calcSec(pl,tp,sz){if(!pl.length)return[];const sec=[],so=[...pl].sort((a,b)=>b.bet-a.bet);
  function sq(it,x,y,w,h){if(!it.length)return;if(it.length===1){const p=it[0];sec.push({pid:p.id,name:p.name,ini:p.ini,color:p.color,bet:p.bet,pct:(p.bet/tp*100).toFixed(1),x,y,w,h,cx:x+w/2,cy:y+h/2});return;}
    const tv=it.reduce((s,p)=>s+p.bet,0),vt=w>=h;let br=[it[0]],brt=Infinity;
    for(let i=0;i<it.length;i++){const rw=it.slice(0,i+1),rv=rw.reduce((s,p)=>s+p.bet,0),st=vt?w*(rv/tv):h*(rv/tv);let wst=0;
      for(const p of rw){const pf=p.bet/rv,cw=vt?st:w*pf,ch=vt?h*pf:st;wst=Math.max(wst,Math.max(cw/Math.max(ch,.1),ch/Math.max(cw,.1)));}
      if(wst<=brt||i===0){brt=wst;br=rw;}else break;}
    const rv=br.reduce((s,p)=>s+p.bet,0),st=vt?w*(rv/tv):h*(rv/tv);let off=0;
    for(const p of br){const pf=p.bet/rv,cl=vt?h*pf:w*pf,sx=vt?x:x+off,sy=vt?y+off:y,sw=vt?st:cl,sh=vt?cl:st;
      sec.push({pid:p.id,name:p.name,ini:p.ini,color:p.color,bet:p.bet,pct:(p.bet/tp*100).toFixed(1),x:sx,y:sy,w:sw,h:sh,cx:sx+sw/2,cy:sy+sh/2});off+=cl;}
    const rest=it.slice(br.length);if(rest.length){if(vt)sq(rest,x+st,y,w-st,h);else sq(rest,x,y+st,w,h-st);}}
  sq(so,0,0,sz,sz);return sec;}

function calcTraj(rng){const m=C.ARENA*.2,x0=m+rng()*(C.ARENA-2*m),y0=m+rng()*(C.ARENA-2*m),angle=rng()*Math.PI*2,speed=24+rng()*12;
  let vx=Math.cos(angle)*speed,vy=Math.sin(angle)*speed,x=x0,y=y0;const r=C.PKR,pts=[];
  for(let i=0;i<10000;i++){pts.push([Math.round(x*10)/10,Math.round(y*10)/10]);x+=vx;y+=vy;
    if(x-r<=0){x=r;vx=Math.abs(vx)*.96;}if(x+r>=C.ARENA){x=C.ARENA-r;vx=-Math.abs(vx)*.96;}
    if(y-r<=0){y=r;vy=Math.abs(vy)*.96;}if(y+r>=C.ARENA){y=C.ARENA-r;vy=-Math.abs(vy)*.96;}
    vx*=C.FRIC;vy*=C.FRIC;if(Math.sqrt(vx*vx+vy*vy)<C.MIN_SP){pts.push([Math.round(x*10)/10,Math.round(y*10)/10]);break;}}
  const sam=[];for(let i=0;i<pts.length;i+=2)sam.push(pts[i]);if(pts.length%2===0)sam.push(pts[pts.length-1]);
  return{pts:sam,angle,sx:x0,sy:y0};}

function recalc(){G.pool=Math.round(G.pl.reduce((s,p)=>s+p.bet,0)*100)/100;G.sectors=calcSec(G.pl,G.pool,C.ARENA);}

const BN=['@cryptowolf','@moonshot','@diamond_hands','@whale_alert','@degen_king','@ton_maxi','@hodler42','@nft_queen','@alpha_hunter','@block_wizard','@satoshi_jr','@pump_master','@chain_smoker','@gas_fee','@rug_check','@yield_farm','@stake_pool','@swap_lord','@bridge_troll','@dao_voter','@meta_verse','@pixel_punk','@ape_strong','@bear_trap','@bull_run','Grey Oscar','Anna K.','Max Power','Luna Star','Crypto Ninja','Блокчейн Бро','ТОН Мастер','Кит Моби','Алмазные Руки','Король Дегенов'];
const BC=['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9','#F0B27A','#82E0AA','#F1948A','#85929E','#73C6B6','#E74C3C','#3498DB','#2ECC71','#F39C12','#9B59B6','#1ABC9C','#E67E22','#34495E','#E91E63','#00BCD4','#FF9800','#8BC34A','#FF5722','#607D8B','#795548','#FF69B4','#00CED1'];
function gI(n){if(n.startsWith('@'))return n.substring(1,3).toUpperCase();const p=n.split(/[\s.]+/).filter(Boolean);return p.length>=2?(p[0][0]+p[1][0]).toUpperCase():n.substring(0,2).toUpperCase();}
let ubn=new Set(),rc=0;
function gBB(c){const r={mass:[0.1,10],mid:[10,100],shark:[100,1000],whale:[1000,50000]}[c];return Math.round(Math.exp(Math.log(r[0])+Math.random()*(Math.log(r[1])-Math.log(r[0])))*100)/100;}
function pBn(){let a=BN.filter(n=>!ubn.has(n));if(!a.length){ubn.clear();a=BN;}const n=a[Math.floor(Math.random()*a.length)];ubn.add(n);return n;}
function sB(){const h=(new Date().getUTCHours()+3)%24;let cfg;if(h>=2&&h<7)cfg={min:2,max:5,sc:.02};else if(h>=17&&h<23)cfg={min:6,max:20,sc:.12};else cfg={min:3,max:10,sc:.06};
  rc++;const n=cfg.min+Math.floor(Math.random()*(cfg.max-cfg.min+1)),b=[];
  for(let i=0;i<n;i++){let cl='mass';const r=Math.random();if(r<.003&&rc%80===0)cl='whale';else if(r<cfg.sc)cl='shark';else if(r<cfg.sc+.25)cl='mid';
    let d;if(cl==='whale'||cl==='shark')d=(C.TIMER-3+Math.random()*2.5)*1000;else if(cl==='mid')d=(5+Math.random()*5)*1000;else d=Math.random()*(C.TIMER-1)*1000;
    b.push({name:pBn(),bet:gBB(cl),color:BC[Math.floor(Math.random()*BC.length)],delay:d});}return b;}

function reset(){G.rid++;G.ph='waiting';G.pl=[];G.pool=0;G.timer=C.TIMER;G.traj=null;G.puckSpawn=null;G.sectors=[];G.winner=null;G.ss=genS();G.ps=genP();G.sh=hashS(G.ss);ubn.clear();bcast();
  setTimeout(()=>{if(G.ph==='waiting'){aBB();setTimeout(()=>{if(G.ph==='waiting')aBB();},1000+Math.random()*1000);}},1000+Math.random()*2000);}
function aBB(){if(G.pl.length>=C.MAX_PLAYERS||!['waiting','countdown'].includes(G.ph))return;const n=pBn(),cl=Math.random()<.7?'mass':'mid';
  addP({id:'bot_'+Date.now()+'_'+Math.random().toString(36).substr(2,5),name:n,ini:gI(n),bet:gBB(cl),color:BC[G.pl.length%BC.length],isBot:true});}
function addP(p){if(G.pl.length>=C.MAX_PLAYERS||['live','spinning','result','paused'].includes(G.ph))return false;G.pl.push(p);recalc();if(G.pl.length>=2&&G.ph==='waiting')startCD();bcast();return true;}
function startCD(){G.ph='countdown';G.timer=C.TIMER;sB().forEach(b=>{setTimeout(()=>{if(G.ph!=='countdown'||G.pl.length>=C.MAX_PLAYERS)return;
  addP({id:'bot_'+Date.now()+'_'+Math.random().toString(36).substr(2,5),name:b.name,ini:gI(b.name),bet:b.bet,color:b.color,isBot:true});},b.delay);});
  clearInterval(tI);tI=setInterval(()=>{G.timer--;if(G.timer<=0){clearInterval(tI);startSpin();}bcast();},1000);}

function startSpin(){G.ph='spinning';const rng=sR(G.ss+G.ps),t=calcTraj(rng);G.traj=t.pts;G.trajAngle=t.angle;G.puckSpawn={x:t.sx,y:t.sy};bcast();
  // Arrow spins for SPIN duration, then launch
  setTimeout(()=>{G.ph='live';io.emit('traj',{pts:G.traj,fps:30});bcast();
    const dur=G.traj.length/30*1000;setTimeout(()=>endR(),dur+300);},C.SPIN);}

function endR(){G.ph='result';const last=G.traj[G.traj.length-1],ws=findW({x:last[0],y:last[1]});
  if(ws){const p=G.pl.find(pl=>pl.id===ws.pid),bet=p?p.bet:0,np=G.pool-bet,comm=Math.round(np*C.COMM*100)/100,wa=Math.round((G.pool-comm)*100)/100,prof=Math.round((wa-bet)*100)/100,mult=bet>0?Math.round((wa/bet)*100)/100:1,pct=bet>0?(bet/G.pool*100).toFixed(1):'0';
    G.winner={name:ws.name,ini:ws.ini,color:ws.color,amt:wa,bet,mult,prof,pct,sid:ws.pid};
    // Credit winner
    const winUser=sockToUser.get(ws.pid);
    if(winUser){const ud=getUserBal(winUser);ud.bal=Math.round((ud.bal+wa)*100)/100;
      const winSock=userToSock.get(winUser);if(winSock)io.to(winSock).emit('bal',{b:ud.bal});}
    if(wa>G.top.amt)G.top={name:ws.name,ini:ws.ini,amt:wa};G.last={name:ws.name,ini:ws.ini,amt:prof};}
  bcast();setTimeout(()=>{G.ph='paused';bcast();setTimeout(reset,C.PAUSE);},C.RES);}

function findW(pt){if(!pt||!G.sectors.length)return null;for(const s of G.sectors)if(pt.x>=s.x&&pt.x<=s.x+s.w&&pt.y>=s.y&&pt.y<=s.y+s.h)return s;
  let mn=Infinity,c=G.sectors[0];for(const s of G.sectors){const d=(pt.x-s.cx)**2+(pt.y-s.cy)**2;if(d<mn){mn=d;c=s;}}return c;}

function bcast(){io.emit('gs',{ph:G.ph,rid:G.rid,pl:G.pl.map(p=>({id:p.id,name:p.name,ini:p.ini,bet:p.bet,color:p.color})),pool:G.pool,timer:G.timer,sh:G.sh,sec:G.sectors,spawn:G.puckSpawn,angle:G.trajAngle,r:C.PKR,w:G.winner,top:G.top,last:G.last});}

// ── REST API for /buy command from bot ──
app.post('/api/buy',function(req,res){
  const{owner,username,amount}=req.body;
  if(owner!==OWNER_ID)return res.status(403).json({error:'Unauthorized'});
  if(!username||typeof amount!=='number'||amount<=0)return res.status(400).json({error:'Bad request'});
  const clean=username.replace(/^@/,'');
  const ud=getUserBal(clean);
  ud.bal=Math.round((ud.bal+amount)*100)/100;
  // If user is online, push balance
  const sockId=userToSock.get(clean);
  if(sockId)io.to(sockId).emit('bal',{b:ud.bal});
  res.json({ok:true,username:clean,balance:ud.bal});
});

// ── Socket.IO ──
io.on('connection',sk=>{
  console.log(`[+] ${sk.id}`);

  sk.on('auth',d=>{
    // Client sends username on connect
    const username=(d.username||'').replace(/^@/,'');
    if(!username)return;
    sockToUser.set(sk.id,username);
    userToSock.set(username,sk.id);
    const ud=getUserBal(username);
    // If client sends their local balance and it's higher (shouldn't happen normally), take server's
    // If client sends lower (spent offline somehow), also take server's
    // Server balance is authoritative after first connect
    sk.emit('bal',{b:ud.bal});
    sk.emit('dep_cooldown',{lastDep:ud.lastDep});
  });

  bcast();
  if(G.ph==='live'&&G.traj)sk.emit('traj',{pts:G.traj,fps:30});

  sk.on('bet',d=>{
    const{name,bet}=d;if(!name||typeof name!=='string')return sk.emit('err',{m:'Неверное имя'});
    const ba=Math.round(parseFloat(bet)*100)/100;if(isNaN(ba)||ba<C.MIN_BET||ba>C.MAX_BET)return sk.emit('err',{m:'Неверная ставка'});
    if(['live','spinning','result','paused'].includes(G.ph))return sk.emit('err',{m:'Ждите раунд'});
    if(G.pl.length>=C.MAX_PLAYERS&&!G.pl.find(p=>p.id===sk.id))return sk.emit('err',{m:'Слоты заняты'});
    const username=sockToUser.get(sk.id);
    if(!username)return sk.emit('err',{m:'Авторизуйтесь'});
    const ud=getUserBal(username);
    if(ba>ud.bal)return sk.emit('err',{m:`Мало: ${ud.bal} TON`});
    ud.bal=Math.round((ud.bal-ba)*100)/100;
    sk.emit('bal',{b:ud.bal});
    const ex=G.pl.find(p=>p.id===sk.id);
    if(ex){ex.bet=Math.round((ex.bet+ba)*100)/100;ex.name=name.substring(0,20);ex.ini=gI(name);recalc();bcast();sk.emit('bet_ok',{bet:ex.bet});}
    else{const ok=addP({id:sk.id,name:name.substring(0,20),ini:gI(name),bet:ba,color:BC[G.pl.length%BC.length],isBot:false});
      if(ok)sk.emit('bet_ok',{bet:ba});else{ud.bal=Math.round((ud.bal+ba)*100)/100;sk.emit('bal',{b:ud.bal});}}
  });

  sk.on('deposit',d=>{
    const username=sockToUser.get(sk.id);if(!username)return;
    const ud=getUserBal(username);
    const now=Date.now();
    if(ud.lastDep&&now-ud.lastDep<24*60*60*1000){
      return sk.emit('err',{m:'Пополнение доступно раз в 24 часа'});
    }
    const amt=Math.min(Math.max(parseFloat(d.amount)||0,1),1000);
    ud.bal=Math.round((ud.bal+amt)*100)/100;
    ud.lastDep=now;
    sk.emit('bal',{b:ud.bal});
    sk.emit('dep_cooldown',{lastDep:ud.lastDep});
  });

  sk.on('disconnect',()=>{
    const username=sockToUser.get(sk.id);
    if(username)userToSock.delete(username);
    sockToUser.delete(sk.id);
    console.log(`[-] ${sk.id}`);
  });
});

server.listen(PORT,()=>{console.log(`\n🎰 Roulette v9 :${PORT}\n`);reset();});