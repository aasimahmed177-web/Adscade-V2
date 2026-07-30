import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:1280,height:900}})).newPage();
await p.goto('file:///Users/aasim/Downloads/Claude/Adscade V2/site/index.html');
await p.waitForTimeout(600);
function srgb(c){c/=255;return c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);}
function lum([r,g,bb]){return .2126*srgb(r)+.7152*srgb(g)+.0722*srgb(bb);}
function ct(f,g){const a=lum(f),c=lum(g);return (Math.max(a,c)+.05)/(Math.min(a,c)+.05);}
function pr(s){const m=(s||'').match(/rgba?\(([^)]+)\)/);if(!m)return null;const q=m[1].split(',').map(parseFloat);return [q[0],q[1],q[2],q.length>3?q[3]:1];}
const rows = await p.evaluate(()=>{const o=[];const w=e=>{const c=getComputedStyle(e);
 if(!e.children.length&&e.textContent?.trim()&&parseFloat(c.fontSize)>=11){const st=[];
 for(let x=e;x;x=x.parentElement){const s=getComputedStyle(x);if(s.backgroundColor!=='rgba(0, 0, 0, 0)')st.push(s.backgroundColor);if(x===document.body)break;}
 st.push(getComputedStyle(document.body).backgroundColor);
 o.push([c.color,st,parseFloat(c.fontSize),c.fontWeight,e.className||e.tagName,e.textContent.trim().slice(0,30)]);}
 [...e.children].forEach(w);};w(document.body);return o;});
function flat(st){let base=null;for(let i=st.length-1;i>=0;i--){const l=pr(st[i]);if(!l)continue;
 if(!base){base=[l[0],l[1],l[2]];continue;}const a=l[3];base=[0,1,2].map(k=>l[k]*a+base[k]*(1-a));}return base;}
const bad=[];
for(const [fg,st,size,wt,cls,txt] of rows){let f=pr(fg);const g=flat(st);if(!f||!g)continue;
 if(f[3]<1)f=[0,1,2].map(k=>f[k]*f[3]+g[k]*(1-f[3]));
 const large=size>=24||(size>=18.66&&parseInt(wt,10)>=700);const need=large?3:4.5;const r=ct(f,g);
 if(r<need)bad.push([r.toFixed(2),need,size,fg,'bg='+g.map(Math.round).join(','),cls,txt]);}
console.log(bad.length+' failing of '+rows.length+'\n');
for(const x of bad) console.log(x.join('  |  '));
await b.close();
