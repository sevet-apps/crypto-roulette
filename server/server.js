// CRYPTO ROULETTE — Server v20 (diagonal treemap + morph)
const express=require('express'),http=require('http'),{Server}=require('socket.io'),cors=require('cors'),crypto=require('crypto'),path=require('path');
const app=express();app.use(cors());app.use(express.json());
app.use(function(req,res,next){res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.setHeader('Pragma','no-cache');res.setHeader('Expires','0');next();});
app.use(express.static(path.join(__dirname,'..','client'),{maxAge:0,etag:false,lastModified:false}));
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:'*',methods:['GET','POST']},maxHttpBufferSize:5e6});
const PORT=process.env.PORT||3000;
const OWNER='lagaet';
const C={MAX_PLAYERS:32,TIMER:15,COMM:0.15,MIN_BET:0.1,MAX_BET:999999.99,ARENA:600,PKR:16,FRIC:0.991,MIN_SP:0.25,SPIN:4500,RES:4500,PAUSE:3000,INIT_BAL:1000};

function genS(){return crypto.randomBytes(32).toString('hex');}
function genP(){return crypto.randomBytes(16).toString('hex');}
function hashS(s){return crypto.createHash('sha256').update(s).digest('hex');}

const balByUser=new Map(),sockToUser=new Map(),userToSock=new Map();
function getUserBal(u){if(!balByUser.has(u))balByUser.set(u,{bal:C.INIT_BAL,lastDep:0});return balByUser.get(u);}

// Rigging queue: username -> true (rig next game for this user)
let rigTarget=null; // {username: string} or null

let G={ph:'waiting',rid:0,pl:[],pool:0,timer:C.TIMER,ss:null,ps:null,sh:null,winner:null,sectors:[],
  top:{name:'—',ini:'—',amt:0},last:{name:'—',ini:'—',amt:0},traj:null,puckSpawn:null};
let tI=null;

function calcSec(pl,tp,sz){
  if(!pl.length)return[];
  // Sort descending — biggest first
  var so=[].concat(pl).sort(function(a,b){return b.bet-a.bet});
  var sec=[];
  
  // Strategy:
  // 1. Biggest player gets a centered rounded region (if >25% of pool)
  // 2. Remaining space is cut around perimeter for smaller players
  // 3. Small players (<5%) stack in corners as triangles
  
  // Start with full arena polygon
  var arena=[[0,0],[sz,0],[sz,sz],[0,sz]];
  var remaining=arena;
  
  // Helper functions
  function polyArea(poly){
    var a=0;for(var i=0;i<poly.length;i++){var j=(i+1)%poly.length;a+=poly[i][0]*poly[j][1]-poly[j][0]*poly[i][1];}return Math.abs(a)/2;
  }
  function polyCentroid(poly){
    var cx=0,cy=0,a=0;
    for(var i=0;i<poly.length;i++){var j=(i+1)%poly.length;var cr=poly[i][0]*poly[j][1]-poly[j][0]*poly[i][1];a+=cr;cx+=(poly[i][0]+poly[j][0])*cr;cy+=(poly[i][1]+poly[j][1])*cr;}
    a/=2;if(Math.abs(a)<0.001){var sx=0,sy=0;poly.forEach(function(p){sx+=p[0];sy+=p[1];});return [sx/poly.length,sy/poly.length];}
    return [cx/(6*a),cy/(6*a)];
  }
  function clipByLine(poly,ax,ay,bx,by,keepLeft){
    if(!poly||poly.length===0)return[];
    var out=[],dx=bx-ax,dy=by-ay;
    function sideOf(p){return (p[0]-ax)*dy-(p[1]-ay)*dx;}
    function inside(p){var s=sideOf(p);return keepLeft?s<=0:s>=0;}
    for(var i=0;i<poly.length;i++){
      var p1=poly[i],p2=poly[(i+1)%poly.length];
      var in1=inside(p1),in2=inside(p2);
      if(in1)out.push(p1);
      if(in1!==in2){
        var s1=sideOf(p1),s2=sideOf(p2);
        if(Math.abs(s1-s2)<1e-9)continue;
        var t=s1/(s1-s2);
        out.push([p1[0]+t*(p2[0]-p1[0]),p1[1]+t*(p2[1]-p1[1])]);
      }
    }
    return out;
  }
  function pushSec(p,poly){
    if(!poly||poly.length<3)return false;
    var cent=polyCentroid(poly);
    var xs=poly.map(function(q){return q[0]}),ys=poly.map(function(q){return q[1]});
    sec.push({pid:p.id,name:p.name,ini:p.ini,color:p.color,bet:p.bet,
      pct:(p.bet/tp*100).toFixed(1),poly:poly,cx:cent[0],cy:cent[1],
      x:Math.min.apply(null,xs),y:Math.min.apply(null,ys),
      w:Math.max.apply(null,xs)-Math.min.apply(null,xs),
      h:Math.max.apply(null,ys)-Math.min.apply(null,ys)});
    return true;
  }
  
  // Recursive split: at each step, cut off smallest from remaining polygon by slicing from an edge
  function processRemaining(items,poly,depth){
    if(!items.length)return;
    if(items.length===1){pushSec(items[0],poly);return;}
    
    // Sort by bet — biggest group first vs smallest group
    var total=items.reduce(function(s,p){return s+p.bet},0);
    
    // If biggest is majority (>45%), cut it as a chunk from center
    // Otherwise split roughly in half
    var biggest=items[0];
    var biggestFrac=biggest.bet/total;
    
    // Bounding box of remaining poly
    var xs=poly.map(function(q){return q[0]}),ys=poly.map(function(q){return q[1]});
    var bx=Math.min.apply(null,xs),by=Math.min.apply(null,ys);
    var bw=Math.max.apply(null,xs)-bx,bh=Math.max.apply(null,ys)-by;
    var vert=bw>=bh;
    
    // Split into 2 groups. Target ~50% split when possible
    var acc=0,si=1;
    for(var i=0;i<items.length-1;i++){acc+=items[i].bet;if(acc>=total*0.5){si=i+1;break;}}
    if(si<1)si=1;if(si>=items.length)si=items.length-1;
    var g1=items.slice(0,si),g2=items.slice(si);
    var w1=g1.reduce(function(s,p){return s+p.bet},0);
    var ratio=w1/total;
    
    // Diagonal tilt for visual variety (alternates by depth)
    var tiltPattern=[0.22,-0.18,0.25,-0.15,0.2,-0.22];
    var tilt=(depth<4&&Math.min(bw,bh)>60)?tiltPattern[depth%tiltPattern.length]:0;
    
    var p1=[],p2=[];
    if(vert){
      var xm=bx+bw*ratio;
      var ax=xm-tilt*bh/2, ay=by;
      var bx2=xm+tilt*bh/2, by2=by+bh;
      p1=clipByLine(poly,ax,ay,bx2,by2,true);
      p2=clipByLine(poly,ax,ay,bx2,by2,false);
    }else{
      var ym=by+bh*ratio;
      var ax2=bx, ay2=ym-tilt*bw/2;
      var bx3=bx+bw, by3=ym+tilt*bw/2;
      p1=clipByLine(poly,ax2,ay2,bx3,by3,true);
      p2=clipByLine(poly,ax2,ay2,bx3,by3,false);
    }
    
    // Fallback: straight cut if diagonal failed
    if(p1.length<3||p2.length<3){
      if(vert){
        var xm2=bx+bw*ratio;
        p1=clipByLine(poly,xm2,by-1,xm2,by+bh+1,true);
        p2=clipByLine(poly,xm2,by-1,xm2,by+bh+1,false);
      }else{
        var ym2=by+bh*ratio;
        p1=clipByLine(poly,bx-1,ym2,bx+bw+1,ym2,true);
        p2=clipByLine(poly,bx-1,ym2,bx+bw+1,ym2,false);
      }
    }
    
    if(p1.length<3||p2.length<3){
      // Last resort: put them both as one
      items.forEach(function(it){pushSec(it,poly);});
      return;
    }
    
    processRemaining(g1,p1,depth+1);
    processRemaining(g2,p2,depth+1);
  }
  
  processRemaining(so,arena,0);
  return sec;}

function polygonCentroid(poly){
  var cx=0,cy=0,a=0;
  for(var i=0;i<poly.length;i++){
    var j=(i+1)%poly.length;
    var cross=poly[i][0]*poly[j][1]-poly[j][0]*poly[i][1];
    a+=cross;cx+=(poly[i][0]+poly[j][0])*cross;cy+=(poly[i][1]+poly[j][1])*cross;
  }
  a/=2;
  if(Math.abs(a)<0.001){var sx=0,sy=0;poly.forEach(function(p){sx+=p[0];sy+=p[1];});return [sx/poly.length,sy/poly.length];}
  return [cx/(6*a),cy/(6*a)];
}

// Generate trajectory from specific parameters
function genTraj(x0,y0,angle,speed){
  let vx=Math.cos(angle)*speed,vy=Math.sin(angle)*speed,x=x0,y=y0;const r=C.PKR,pts=[];
  for(let i=0;i<10000;i++){pts.push([Math.round(x*10)/10,Math.round(y*10)/10]);x+=vx;y+=vy;
    if(x-r<=0){x=r;vx=Math.abs(vx)*.96;}if(x+r>=C.ARENA){x=C.ARENA-r;vx=-Math.abs(vx)*.96;}
    if(y-r<=0){y=r;vy=Math.abs(vy)*.96;}if(y+r>=C.ARENA){y=C.ARENA-r;vy=-Math.abs(vy)*.96;}
    vx*=C.FRIC;vy*=C.FRIC;if(Math.sqrt(vx*vx+vy*vy)<C.MIN_SP){pts.push([Math.round(x*10)/10,Math.round(y*10)/10]);break;}}
  const sam=[];for(let i=0;i<pts.length;i+=2)sam.push(pts[i]);if(pts.length%2===0)sam.push(pts[pts.length-1]);
  return{pts:sam,sx:x0,sy:y0};}

function calcTrajRandom(){
  const m=C.ARENA*.2;
  const x0=m+Math.random()*(C.ARENA-2*m),y0=m+Math.random()*(C.ARENA-2*m);
  const angle=Math.random()*Math.PI*2,speed=24+Math.random()*12;
  const t=genTraj(x0,y0,angle,speed);t.angle=angle;return t;}

// Find which sector a point lands on
// Point-in-polygon (ray casting)
function pip(px,py,poly){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){
  const xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];
  if(((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi))inside=!inside;}return inside;}

function findSector(pt,sectors){
  if(!sectors.length)return null;
  for(const s of sectors)if(s.poly&&pip(pt[0]||pt.x,pt[1]||pt.y,s.poly))return s;
  // Fallback: bounding box
  for(const s of sectors)if((pt[0]||pt.x)>=s.x&&(pt[0]||pt.x)<=s.x+s.w&&(pt[1]||pt.y)>=s.y&&(pt[1]||pt.y)<=s.y+s.h)return s;
  let mn=Infinity,c=sectors[0];for(const s of sectors){const d=((pt[0]||pt.x)-s.cx)**2+((pt[1]||pt.y)-s.cy)**2;if(d<mn){mn=d;c=s;}}return c;}

// Generate rigged trajectory that lands on target player's sector
function calcTrajRigged(targetName,sectors){
  // Find target sector
  const targetSec=sectors.find(s=>s.name.toLowerCase().includes(targetName.toLowerCase())||
    s.pid.toLowerCase().includes(targetName.toLowerCase()));
  if(!targetSec){console.log('[RIG] Target sector not found for:',targetName);return calcTrajRandom();}
  
  // Brute force: generate trajectories until one lands on target sector
  for(let attempt=0;attempt<3000;attempt++){
    const t=calcTrajRandom();
    const last=t.pts[t.pts.length-1];
    const landSec=findSector(last,sectors);
    if(landSec&&landSec.pid===targetSec.pid){
      console.log('[RIG] Found matching trajectory on attempt',attempt+1,'for',targetName);
      return t;
    }
  }
  // Fallback: spawn directly inside target sector
  console.log('[RIG] Brute force failed, using direct placement for',targetName);
  const cx=targetSec.cx,cy=targetSec.cy;
  const angle=Math.random()*Math.PI*2,speed=24+Math.random()*12;
  const t=genTraj(cx,cy,angle,speed);t.angle=angle;return t;
}

function recalc(){G.pool=Math.round(G.pl.reduce((s,p)=>s+p.bet,0)*100)/100;try{G.sectors=calcSec(G.pl,G.pool,C.ARENA);}catch(e){console.error('calcSec error:',e.message,e.stack);G.sectors=[];}}

const BN=['@cryptowolf','@moonshot','@diamond_hands','@whale_alert','@degen_king','@ton_maxi','@hodler42','@nft_queen','@alpha_hunter','@block_wizard','@satoshi_jr','@pump_master','@chain_smoker','@gas_fee','@rug_check','@yield_farm','@stake_pool','@swap_lord','@bridge_troll','@dao_voter','@meta_verse','@pixel_punk','@ape_strong','@bear_trap','@bull_run','Grey Oscar','Anna K.','Max Power','Luna Star','Crypto Ninja','Блокчейн Бро','ТОН Мастер','Кит Моби','Алмазные Руки','Король Дегенов'];
const BC=['#FF4444','#00D4AA','#2196F3','#FF9800','#E91E63','#8BC34A','#9C27B0','#00BCD4','#FF5722','#CDDC39','#3F51B5','#FF6D00','#26A69A','#D81B60','#7C4DFF','#F44336','#00E5FF','#76FF03','#FFD600','#AA00FF','#1DE9B6','#FF3D00','#304FFE','#C6FF00','#FF1744','#00B8D4','#64DD17','#DD2C00','#6200EA','#00C853','#F50057','#18FFFF'];
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

function startSpin(){
  G.ph='spinning';
  
  // Generate trajectory — rigged or random
  let t;
  if(rigTarget){
    console.log('[RIG] Rigging game #'+G.rid+' for: '+rigTarget.username);
    t=calcTrajRigged(rigTarget.username,G.sectors);
    rigTarget=null; // one-time use
  }else{
    t=calcTrajRandom();
  }
  
  G.traj=t.pts;
  G.puckSpawn={x:t.sx,y:t.sy};
  G.trajAngle=t.angle||0;
  bcast();
  
  setTimeout(()=>{G.ph='live';io.emit('traj',{pts:G.traj,fps:30});bcast();
    const dur=G.traj.length/30*1000;setTimeout(()=>endR(),dur+300);},C.SPIN);
}

function endR(){G.ph='result';const last=G.traj[G.traj.length-1];
  const ws=findSector(last,G.sectors);
  if(ws){const p=G.pl.find(pl=>pl.id===ws.pid),bet=p?p.bet:0,np=G.pool-bet,comm=Math.round(np*C.COMM*100)/100,wa=Math.round((G.pool-comm)*100)/100,prof=Math.round((wa-bet)*100)/100,mult=bet>0?Math.round((wa/bet)*100)/100:1,pct=bet>0?(bet/G.pool*100).toFixed(1):'0';
    G.winner={name:ws.name,ini:ws.ini,color:ws.color,amt:wa,bet,mult,prof,pct,sid:ws.pid};
    const winUser=sockToUser.get(ws.pid);
    if(winUser){const ud=getUserBal(winUser);ud.bal=Math.round((ud.bal+wa)*100)/100;
      const winSock=userToSock.get(winUser);if(winSock)io.to(winSock).emit('bal',{b:ud.bal});}
    if(wa>G.top.amt)G.top={name:ws.name,ini:ws.ini,amt:wa};G.last={name:ws.name,ini:ws.ini,amt:prof};}
  bcast();setTimeout(()=>{G.ph='paused';bcast();setTimeout(reset,C.PAUSE);},C.RES);}

function bcast(){io.emit('gs',{ph:G.ph,rid:G.rid,pl:G.pl.map(p=>({id:p.id,name:p.name,ini:p.ini,bet:p.bet,color:p.color})),pool:G.pool,timer:G.timer,sh:G.sh,sec:G.sectors,spawn:G.puckSpawn,angle:G.trajAngle,r:C.PKR,w:G.winner,top:G.top,last:G.last});}

// ── REST API ──
app.post('/api/buy',function(req,res){
  const{owner,username,amount}=req.body;
  if(owner!==OWNER)return res.status(403).json({error:'Unauthorized'});
  if(!username||typeof amount!=='number'||amount<=0)return res.status(400).json({error:'Bad request'});
  const clean=username.replace(/^@/,'');const ud=getUserBal(clean);
  ud.bal=Math.round((ud.bal+amount)*100)/100;
  const sockId=userToSock.get(clean);if(sockId)io.to(sockId).emit('bal',{b:ud.bal});
  res.json({ok:true,username:clean,balance:ud.bal});});

app.post('/api/rig',function(req,res){
  const{owner,username}=req.body;
  if(owner!==OWNER)return res.status(403).json({error:'Unauthorized'});
  if(!username)return res.status(400).json({error:'Need username'});
  const clean=username.replace(/^@/,'');
  rigTarget={username:clean};
  console.log('[RIG] Queued rigging for: @'+clean+' (next game)');
  res.json({ok:true,username:clean,message:'Next game will be rigged for @'+clean});});

// ── Socket.IO ──
io.on('connection',sk=>{
  console.log(`[+] ${sk.id}`);
  sk.on('auth',d=>{const username=(d.username||'').replace(/^@/,'');if(!username)return;
    sockToUser.set(sk.id,username);userToSock.set(username,sk.id);
    const ud=getUserBal(username);sk.emit('bal',{b:ud.bal});sk.emit('dep_cooldown',{lastDep:ud.lastDep});});
  bcast();if(G.ph==='live'&&G.traj)sk.emit('traj',{pts:G.traj,fps:30});
  sk.on('bet',d=>{const{name,bet}=d;if(!name||typeof name!=='string')return sk.emit('err',{m:'Неверное имя'});
    const ba=Math.round(parseFloat(bet)*100)/100;if(isNaN(ba)||ba<C.MIN_BET||ba>C.MAX_BET)return sk.emit('err',{m:'Неверная ставка'});
    if(['live','spinning','result','paused'].includes(G.ph))return sk.emit('err',{m:'Ждите раунд'});
    if(G.pl.length>=C.MAX_PLAYERS&&!G.pl.find(p=>p.id===sk.id))return sk.emit('err',{m:'Слоты заняты'});
    const username=sockToUser.get(sk.id);if(!username)return sk.emit('err',{m:'Авторизуйтесь'});
    const ud=getUserBal(username);if(ba>ud.bal)return sk.emit('err',{m:`Мало: ${ud.bal} TON`});
    ud.bal=Math.round((ud.bal-ba)*100)/100;sk.emit('bal',{b:ud.bal});
    const ex=G.pl.find(p=>p.id===sk.id);
    if(ex){ex.bet=Math.round((ex.bet+ba)*100)/100;ex.name=name.substring(0,20);ex.ini=gI(name);recalc();bcast();sk.emit('bet_ok',{bet:ex.bet});}
    else{const ok=addP({id:sk.id,name:name.substring(0,20),ini:gI(name),bet:ba,color:BC[G.pl.length%BC.length],isBot:false});
      if(ok)sk.emit('bet_ok',{bet:ba});else{ud.bal=Math.round((ud.bal+ba)*100)/100;sk.emit('bal',{b:ud.bal});}}});
  sk.on('deposit',d=>{const username=sockToUser.get(sk.id);if(!username)return;
    const ud=getUserBal(username);const now=Date.now();
    if(ud.lastDep&&now-ud.lastDep<24*60*60*1000)return sk.emit('err',{m:'Пополнение раз в 24 часа'});
    const amt=Math.min(Math.max(parseFloat(d.amount)||0,1),1000);
    ud.bal=Math.round((ud.bal+amt)*100)/100;ud.lastDep=now;
    sk.emit('bal',{b:ud.bal});sk.emit('dep_cooldown',{lastDep:ud.lastDep});});
  sk.on('disconnect',()=>{const username=sockToUser.get(sk.id);if(username)userToSock.delete(username);sockToUser.delete(sk.id);});
});

server.listen(PORT,()=>{console.log(`\n🎰 Roulette v10 :${PORT}\n`);reset();});