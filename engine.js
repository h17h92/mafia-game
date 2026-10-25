const Engine=(function(){
  const shuffle=(a,r=Math.random)=>{a=a.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
  const deck=n=>{const m=Math.max(1,Math.floor(n/4));const d=[];for(let i=0;i<m;i++)d.push('mafia');d.push('investigator','doctor');if(n>=8)d.push('mute');if(n>=10)d.push('sniper');while(d.length<n)d.push('citizen');return d.slice(0,n);};
  const assign=(names,r)=>{const d=shuffle(deck(names.length),r),o={};names.forEach((n,i)=>o[n]=d[i]);return o;};
  const plurality=(list,r=Math.random,prefer=null)=>{if(!list.length)return null;const c={};list.forEach(x=>c[x]=(c[x]||0)+1);const top=Math.max(...Object.values(c));const tied=Object.keys(c).filter(k=>c[k]===top);return prefer&&tied.includes(prefer)?prefer:tied[Math.floor(r()*tied.length)];};
  const resolveNight=({alive,mafiaVotes,protect,shoot,rnd,prefer})=>{
    const victim=plurality(mafiaVotes.filter(v=>alive.includes(v)),rnd,prefer);
    const saved=!!victim&&protect===victim;const dead=[];
    if(victim&&!saved)dead.push(victim);
    const shot=!!shoot&&alive.includes(shoot)&&!dead.includes(shoot);if(shot)dead.push(shoot);
    return {victim,saved,shot,dead};};
  const tally=(votes)=>{const c={};Object.values(votes).forEach(t=>c[t]=(c[t]||0)+1);const ks=Object.keys(c);if(!ks.length)return {target:null,tie:false,counts:c};
    const top=Math.max(...ks.map(k=>c[k]));const tied=ks.filter(k=>c[k]===top);return tied.length===1?{target:tied[0],tie:false,counts:c}:{target:null,tie:true,counts:c};};
  const checkWin=(alive,roles)=>{const m=alive.filter(n=>roles[n]==='mafia').length,o=alive.length-m;if(m===0)return 'citizens';if(m>=o)return 'mafia';return null;};
  return {shuffle,deck,assign,plurality,resolveNight,tally,checkWin};
})();
if(typeof module!=='undefined')module.exports=Engine;
