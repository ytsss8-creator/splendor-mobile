/* Frozen legacy-v1 policy: original function bodies, isolated observation-only context. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SplendorLegacyAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const COLORS=['w','u','g','r','k'],ALL=[...COLORS,'y'];
  const clone=value=>JSON.parse(JSON.stringify(value));
  const cnt=value=>Object.values(value||{}).reduce((a,b)=>a+b,0);
  function context(observation, rng) {
    // Reindex the observer as legacy slot 1. No actual deck, setup or replay enters here.
    const S={market:clone(observation.market),bank:clone(observation.bank),nobles:clone(observation.nobles),
      players:[null,clone(observation.players[observation.self])],botRng:rng>>>0,turn:1,over:false,modal:null};
    let action=null;const returned=[];
    const matchMode=()=> 'ai';
    // Original discard logging expressions are evaluated but never shown here.
    const playerLabel=()=>'';const C=Object.fromEntries(ALL.map(color=>[color,{name:''}]));
    const pay=card=>{action={type:'buy',cardId:card.id};return true};
    const take=colors=>{action={type:'take',colors:[...colors]};return true};
    const reserve=card=>{action={type:'reserve',cardId:card.id};return true};
    const afterAction=()=>{};const goNext=()=>{};
    const putLog=(who,text,event)=>{if(event?.type==='discard')returned.push(event.color)};
function bonusCards(player,c){return player.bonuses[c]||0}
function price(card,p){let req={},short=0;for(const c of COLORS){req[c]=Math.max(0,(card.cost[c]||0)-bonusCards(p,c));short+=Math.max(0,req[c]-(p.tokens[c]||0));}return{req,short,left:Math.max(0,short-(p.tokens.y||0))}}
function canBuy(card,p){return price(card,p).left===0}
function canTake(pick,who){let p=S.players[who];const available=COLORS.filter(c=>S.bank[c]>0).length;if(available>0&&pick.length===Math.min(3,available)&&new Set(pick).size===pick.length)return pick.every(c=>COLORS.includes(c)&&S.bank[c]>0);if(pick.length===2&&pick[0]===pick[1])return S.bank[pick[0]]>=4;return false;}
function owned(card,p){return p.reserved.some(a=>a.id===card.id)}
function marketOf(id){for(let t=1;t<=3;t++){let a=S.market[t].find(a=>a.id===id);if(a)return a}return null}
function getMarketCards(){return [3,2,1].flatMap(t=>S.market[t]);}
function allOptions(p){return [...getMarketCards(),...p.reserved]}
function weightedColor(c,p){let value=.85;const market=getMarketCards();for(const card of market.filter(x=>x.score>=2)){let d=price(card,p).req[c]||0;if(d>0)value+=Math.min(3,d)*.075;}for(const n of S.nobles){let deficit=(n.req[c]||0)-(p.bonuses[c]||0);if(deficit>0&&deficit<=2)value+=.18;}return value}
function botRandom(){S.botRng=(Math.imul(1664525,S.botRng>>>0)+1013904223)>>>0;return S.botRng/4294967296;}
function lookAhead(card,p){const pr=price(card,p),needed=pr.left,bonus=weightedColor(card.color,p);let nobleBoost=0;for(const n of S.nobles){const req=n.req[card.color]||0;if(req>0){const left=COLORS.reduce((a,c)=>a+Math.max(0,(n.req[c]||0)-(p.bonuses[c]||0)-(c===card.color?1:0)),0);nobleBoost=Math.max(nobleBoost,Math.max(0,1.4-left*.26))}}
const distance=Math.ceil(needed/2.4);let benefit=card.score*(p.score>=8?2.15:1.55)+(p.cards.length<5?1.25:0.5)*bonus+nobleBoost+(card.tier===1&&p.cards.length<5?.3:0);let speed=1+distance*.57;let utility=benefit/speed;if(card.score===0&&p.cards.length>=8)utility*=.5;if(card.score>=3&&p.score>=8)utility+=2;if(card.score+p.score>=15&&needed<=3)utility+=10;if(p.cards.length<3){utility*=card.tier===1?1.85:card.tier===2?.7:.28}else if(p.cards.length<6){utility*=card.tier===1?1.06:card.tier===2?1.16:.6}else if(p.cards.length<9){utility*=card.tier===3?.85:1.0}return{card,utility,needed,pr}}
function usefulTake(p){const candidates=[];
for(let i=0;i<COLORS.length;i++)for(let j=i+1;j<COLORS.length;j++)for(let k=j+1;k<COLORS.length;k++){let cs=[COLORS[i],COLORS[j],COLORS[k]];if(canTake(cs,1))candidates.push(cs)}
if(COLORS.filter(c=>S.bank[c]>0).length<3){const cs=COLORS.filter(c=>S.bank[c]>0);if(cs.length&&canTake(cs,1))candidates.push(cs)}
for(const c of COLORS)if(S.bank[c]>=4)candidates.push([c,c]);
const top=allOptions(p).map(x=>lookAhead(x,p)).sort((a,b)=>b.utility-a.utility).slice(0,7);
let best=null,score=-Infinity;
for(const cs of candidates){let v=0;for(const op of top){let gain=0;const needed=price(op.card,p).req;
for(const c of cs){if(needed[c]>(p.tokens[c]||0)+cs.slice(0,cs.indexOf(c)).filter(x=>x===c).length)gain+=1}v+=Math.max(0,op.utility)*gain*.26;}
let demand=COLORS.reduce((a,c)=>a+(p.tokens[c]||0),0);v+=cs.length*.17-(cnt(p.tokens)+cs.length>10?2:0);for(const c of cs){if(p.tokens[c]>=4)v-=.45;}v+=botRandom()*.18;
if(v>score){score=v;best=cs}}
return{best,score};}
function autoDiscard(who){const p=S.players[who];while(cnt(p.tokens)>10){let priority=COLORS.map(c=>({c,v:p.tokens[c]/(1+weightedColor(c,p))})).filter(x=>p.tokens[x.c]>0).sort((a,b)=>b.v-a.v);let c=priority[0]?.c||'y';if(!p.tokens[c])c=ALL.find(x=>p.tokens[x]>0);p.tokens[c]--;S.bank[c]++;putLog(who,`${playerLabel(who)} 因超过10枚上限弃掉1枚${C[c].name}宝石`,{type:'discard',color:c})} }
function botTurn(){if(matchMode()!=='ai'||S.over||S.turn!==1||S.modal)return;const p=S.players[1];let opts=allOptions(p).map(c=>lookAhead(c,p)).sort((a,b)=>b.utility-a.utility),buys=opts.filter(x=>x.needed===0);
let takeopt=usefulTake(p);
let bought=false;
if(buys.length){let b=buys[0];const base=b.card.score*2.2+weightedColor(b.card.color,p)+(p.cards.length<4?1:0);if(b.card.score>0||p.cards.length<5||base>=3.0||cnt(p.tokens)>=8){pay(b.card,1);bought=true}}
if(!bought){let takeChoice=takeopt.best;
if(takeChoice&&cnt(p.tokens)>=9&&buys.length){pay(buys[0].card,1)}
else if(takeChoice){take(takeChoice,1)}
else if(buys.length){pay(buys[0].card,1)}
else if(p.reserved.length<3&&S.bank.y>0){let c=opts.find(x=>marketOf(x.card.id)&&x.card.score>=2);if(c)reserve(c.card,1);else{let c2=getMarketCards()[0];if(c2)reserve(c2,1)}}
else if(getMarketCards().length&&p.reserved.length<3)reserve(getMarketCards()[0],1)
else {putLog('sys','AI 当前没有可执行行动。');goNext(1);return}}
afterAction(1)}
    return {decide(){botTurn();return {strategyId:'legacy-v1',action,nextRng:S.botRng}},
      discard(){autoDiscard(1);return returned}};
  }
  return Object.freeze({strategyId:'legacy-v1',
    decide:(observation,rng)=>context(observation,rng).decide(),
    discardColors:observation=>context(observation,0).discard()});
});
