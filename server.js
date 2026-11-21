const express=require("express"),http=require("http"),crypto=require("crypto"),fs=require("fs"),path=require("path");
const {Server}=require("socket.io");
const TOKEN=process.env.ADMIN_TOKEN;
if(!TOKEN){console.error("Set ADMIN_TOKEN first, e.g.  ADMIN_TOKEN=mysecret node server.js");process.exit(1)}
const DATA=path.join(process.env.DATA_DIR||__dirname,"data.json");
const app=express(),srv=http.createServer(app),io=new Server(srv);
app.use(express.json({limit:"10kb"}));app.use(express.static(__dirname+"/public"));
app.get("/admin",(q,r)=>r.sendFile(__dirname+"/public/admin.html"));

/* ---------- storage (demo coins only) ---------- */
let DB={users:{},sessions:{},suggestions:[]};
try{DB=Object.assign(DB,JSON.parse(fs.readFileSync(DATA,"utf8")))}catch(e){}
let st=null;function save(){if(st)return;st=setTimeout(()=>{st=null;fs.writeFile(DATA,JSON.stringify(DB),()=>{})},500)}
const r2=n=>Math.round(n*100)/100;
function hash(pw,salt){return crypto.scryptSync(pw,salt,32).toString("hex")}
function tokenFor(u){const t=crypto.randomBytes(24).toString("hex");DB.sessions[t]=u;save();return t}
function view(u){const x=DB.users[u];return{username:u,name:x.name,balance:x.balance}}
function bearer(q,r,n){const t=(q.get("authorization")||"").replace("Bearer ","");const u=DB.sessions[t];
  if(!u||!DB.users[u])return r.status(401).json({error:"আবার login করুন"});q.user=u;n()}
const DAY=864e5;
function tx(u,type,amt){const x=DB.users[u];(x.tx=x.tx||[]).unshift({t:Date.now(),type,amt:r2(amt),bal:x.balance});x.tx=x.tx.slice(0,100)}
function rec(u,o){const x=DB.users[u];(x.bets=x.bets||[]).unshift(Object.assign({t:Date.now()},o));x.bets=x.bets.slice(0,100)}
app.get("/api/history",(q,r,n)=>bearer(q,r,n),(q,r)=>{const x=DB.users[q.user],b=x.bets||[];
  let won=0,lost=0,staked=0,ret=0;b.forEach(e=>{staked+=e.amount;ret+=e.win;e.win>0?won++:lost++});
  r.json({bets:b.slice(0,50),tx:(x.tx||[]).slice(0,50),stats:{rounds:b.length,won,lost,staked:r2(staked),returned:r2(ret),profit:r2(ret-staked)},claimAt:x.claimAt,checkAt:x.checkAt})});

/* ---------- player API ---------- */
app.post("/api/signup",(q,r)=>{
  const u=String(q.body.username||"").trim().toLowerCase(),pw=String(q.body.password||""),name=String(q.body.name||"").trim().slice(0,40);
  if(!/^[a-z0-9_]{3,20}$/.test(u))return r.json({error:"ইউজারনেম ৩-২০ অক্ষর (a-z, 0-9, _) হতে হবে।"});
  if(pw.length<6)return r.json({error:"পাসওয়ার্ড কমপক্ষে ৬ অক্ষর হতে হবে।"});
  if(DB.users[u])return r.json({error:"এই ইউজারনেম আগে থেকেই ব্যবহার করা হয়েছে।"});
  const salt=crypto.randomBytes(16).toString("hex");
  DB.users[u]={name:name||u,salt,hash:hash(pw,salt),balance:1000,claimAt:0,checkAt:0};
  const ref=String(q.body.ref||"").toLowerCase();
  if(ref&&ref!==u&&DB.users[ref]){DB.users[u].balance=r2(DB.users[u].balance+100);tx(u,"invite",100);DB.users[ref].balance=r2(DB.users[ref].balance+100);tx(ref,"invite",100);io.to("u:"+ref).emit("bal",DB.users[ref].balance)}
  r.json(Object.assign({token:tokenFor(u)},view(u)));
});
app.post("/api/login",(q,r)=>{
  const u=String(q.body.username||"").trim().toLowerCase(),x=DB.users[u];
  if(!x||hash(String(q.body.password||""),x.salt)!==x.hash)return r.json({error:"ইউজারনেম অথবা পাসওয়ার্ড সঠিক নয়।"});
  r.json(Object.assign({token:tokenFor(u)},view(u)));
});
app.get("/api/me",bearer,(q,r)=>r.json(view(q.user)));
function wait(ms){const h=Math.ceil(ms/36e5);return h+" ঘণ্টা পর আবার নিন।"}
app.post("/api/claim",bearer,(q,r)=>{const x=DB.users[q.user],n=Date.now();
  if(n-x.claimAt<DAY)return r.json({error:wait(DAY-(n-x.claimAt))});
  x.claimAt=n;x.balance=r2(x.balance+100);tx(q.user,"claim",100);save();r.json(view(q.user))});
app.post("/api/checkin",bearer,(q,r)=>{const x=DB.users[q.user],n=Date.now();
  if(n-x.checkAt<DAY)return r.json({error:wait(DAY-(n-x.checkAt))});
  x.checkAt=n;x.balance=r2(x.balance+50);tx(q.user,"checkin",50);save();r.json(view(q.user))});
app.post("/api/deposit",bearer,(q,r)=>{const a=Number(q.body.amount),x=DB.users[q.user];
  if(!isFinite(a)||a<1||a>10000)return r.json({error:"১ থেকে ১০০০০ এর মধ্যে লিখুন।"});
  x.balance=r2(x.balance+a);tx(q.user,"deposit",a);save();io.to("u:"+q.user).emit("bal",x.balance);r.json(view(q.user))});
app.post("/api/withdraw",bearer,(q,r)=>{const a=Number(q.body.amount),x=DB.users[q.user];
  if(!isFinite(a)||a<=0)return r.json({error:"সঠিক পরিমাণ লিখুন।"});
  if(a>x.balance)return r.json({error:"আপনার অ্যাকাউন্টে এত কয়েন নেই।"});
  x.balance=r2(x.balance-a);tx(q.user,"withdraw",-a);save();io.to("u:"+q.user).emit("bal",x.balance);r.json(view(q.user))});

/* ---------- missions, rebate, security, suggestions ---------- */
const day=t=>new Date(t).toISOString().slice(0,10);
function missions(u){const x=DB.users[u],d=day(Date.now());
  if(!x.mis||x.mis.day!==d)x.mis={day:d,done:[]};
  const today=(x.bets||[]).filter(e=>day(e.t)===d),wins=today.filter(e=>e.win>0).length;
  return [{id:"play5",title:"আজ ৫টি রাউন্ড খেলুন",need:5,have:today.length,reward:50},
          {id:"win3",title:"আজ ৩বার cash out করুন",need:3,have:wins,reward:100}]
    .map(m=>Object.assign(m,{claimed:x.mis.done.includes(m.id)}))}
app.get("/api/missions",bearer,(q,r)=>r.json({list:missions(q.user)}));
app.post("/api/missions/claim",bearer,(q,r)=>{const m=missions(q.user).find(e=>e.id===q.body.id),x=DB.users[q.user];
  if(!m||m.claimed||m.have<m.need)return r.json({error:"এখনো পূর্ণ হয়নি।"});
  x.mis.done.push(m.id);x.balance=r2(x.balance+m.reward);tx(q.user,"mission",m.reward);save();r.json(view(q.user))});
const RATE=0.02,pend=x=>Math.floor(Math.max(0,(x.staked||0)-(x.rebated||0))*RATE*100)/100;
app.get("/api/rebate",bearer,(q,r)=>r.json({pending:pend(DB.users[q.user]),rate:RATE*100}));
app.post("/api/rebate/claim",bearer,(q,r)=>{const x=DB.users[q.user],p=pend(x);
  if(p<1)return r.json({error:"কমপক্ষে ১ কয়েন জমতে হবে।"});
  x.rebated=x.staked;x.balance=r2(x.balance+p);tx(q.user,"rebate",p);save();r.json(view(q.user))});
app.post("/api/password",bearer,(q,r)=>{const x=DB.users[q.user],np=String(q.body.new||"");
  if(hash(String(q.body.old||""),x.salt)!==x.hash)return r.json({error:"পুরনো পাসওয়ার্ড ভুল।"});
  if(np.length<6)return r.json({error:"নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষর।"});
  x.salt=crypto.randomBytes(16).toString("hex");x.hash=hash(np,x.salt);save();r.json({ok:1})});
app.post("/api/suggest",bearer,(q,r)=>{const x=DB.users[q.user],t=String(q.body.text||"").trim().slice(0,500),n=Date.now();
  if(!t)return r.json({error:"কিছু লিখুন।"});
  if(n-(x.sugAt||0)<30000)return r.json({error:"একটু পরে আবার পাঠান।"});
  x.sugAt=n;DB.suggestions.unshift({u:q.user,t:n,text:t,kind:String(q.body.kind||"Suggestion").slice(0,20)});DB.suggestions=DB.suggestions.slice(0,200);save();r.json({ok:1})});

/* ---------- crash rounds ---------- */
const S={mode:"queue",queue:[],min:1.1,max:10,wait:8,log:[],phase:"wait",startAt:0,crashAt:0,cp:null};
const K=0.12,BETS={}; // BETS[user]=[amountSlot0,amountSlot1]
function pick(){let v;
  if(S.mode==="queue"&&S.queue.length)v=Number(S.queue.shift());
  else if(S.mode==="range")v=S.min+Math.random()*(S.max-S.min);
  else v=Math.floor(97/(1-Math.random()))/100;
  return r2(Math.min(1000,Math.max(1,v||1)))}
function round(){
  S.phase="wait";S.cp=null;
  setTimeout(()=>{
    const cp=pick();S.cp=cp;S.phase="run";S.startAt=Date.now();
    const dur=Math.max(300,Math.log(cp)/K*1000);S.crashAt=S.startAt+dur;
    io.emit("start",{elapsed:0});
    setTimeout(()=>{S.log.unshift(cp);S.log=S.log.slice(0,30);S.phase="wait";
      for(const u in BETS){BETS[u].forEach(a=>{if(a>0)rec(u,{amount:a,mult:cp,win:0,result:"lose"})});delete BETS[u]}
      save();
      io.emit("crash",{v:cp});round()},dur);
  },S.wait*1000);
}
io.on("connection",s=>{
  s.emit("history",S.log.slice(0,14));
  if(S.phase==="run")s.emit("start",{elapsed:(Date.now()-S.startAt)/1000});
  s.on("auth",t=>{const u=DB.sessions[t];if(!u||!DB.users[u])return;
    s.data.user=u;s.join("u:"+u);s.emit("bal",DB.users[u].balance);s.emit("state",{bets:BETS[u]||[0,0]})});
  const me=()=>s.data.user;
  s.on("bet",d=>{const u=me();if(!u)return s.emit("err","আবার login করুন");
    const a=Number(d&&d.amount),i=d&&d.slot,x=DB.users[u];
    if(S.phase!=="wait")return s.emit("err","রাউন্ড শুরু হয়ে গেছে।");
    if(i!==0&&i!==1)return;if(!isFinite(a)||a<1||a>100000)return s.emit("err","সঠিক পরিমাণ দিন।");
    const b=BETS[u]=BETS[u]||[0,0];if(b[i])return;
    if(a>x.balance)return s.emit("err","Not enough coins. Claim more on the Member page");
    x.balance=r2(x.balance-a);x.staked=r2((x.staked||0)+a);b[i]=a;tx(u,"bet",-a);save();
    io.to("u:"+u).emit("bal",x.balance);s.emit("bet_ok",{slot:i,amount:a})});
  s.on("cancel",d=>{const u=me(),i=d&&d.slot;if(!u||S.phase!=="wait")return;
    const b=BETS[u];if(!b||!b[i])return;const x=DB.users[u];
    x.balance=r2(x.balance+b[i]);tx(u,"cancel",b[i]);b[i]=0;save();
    io.to("u:"+u).emit("bal",x.balance);s.emit("cancel_ok",{slot:i})});
  s.on("cash",d=>{const u=me(),i=d&&d.slot;if(!u)return;
    const b=BETS[u],now=Date.now();
    if(S.phase!=="run"||now>=S.crashAt||!b||!b[i])return s.emit("err","");
    const mult=Math.min(S.cp,Math.floor(Math.exp(K*(now-S.startAt)/1000)*100)/100),win=r2(b[i]*mult),x=DB.users[u];
    rec(u,{amount:b[i],mult,win,result:"win"});b[i]=0;x.balance=r2(x.balance+win);tx(u,"cashout",win);save();
    io.to("u:"+u).emit("bal",x.balance);s.emit("cash_ok",{slot:i,win,m:mult})});
});

/* ---------- admin API ---------- */
function auth(q,r,n){q.get("x-admin-token")===TOKEN?n():r.status(401).json({error:"bad token"})}
const clean=a=>(a||[]).map(Number).filter(n=>n>=1&&isFinite(n)).map(n=>r2(Math.min(1000,n)));
app.get("/api/suggestions",auth,(q,r)=>r.json(DB.suggestions));
const pub=()=>Object.assign({},S,{players:Object.keys(DB.users).length});
app.get("/api/state",auth,(q,r)=>r.json(pub()));
app.post("/api/queue",auth,(q,r)=>{const n=clean(q.body.nums);S.queue=q.body.front?n.concat(S.queue):S.queue.concat(n);r.json(pub())});
app.delete("/api/queue/:i",auth,(q,r)=>{S.queue.splice(+q.params.i,1);r.json(pub())});
app.post("/api/queue/clear",auth,(q,r)=>{S.queue=[];r.json(pub())});
app.post("/api/config",auth,(q,r)=>{const b=q.body;
  if(["queue","range","random"].includes(b.mode))S.mode=b.mode;
  S.min=Math.max(1,+b.min||1);S.max=Math.max(S.min,+b.max||10);S.wait=Math.min(60,Math.max(6,+b.wait||8));r.json(pub())});

round();
srv.listen(process.env.PORT||3000,()=>console.log("MH333 running on port "+(process.env.PORT||3000)));
