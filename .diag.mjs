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
 if(!e.children.length&&e.textContent?.trim()&&parseFloat(c.fontSize)>=11){let x=e,bg='rgba(0, 0, 0, 0)';
 while(x&&bg==='rgba(0, 0, 0, 0)'){bg=getComputedStyle(x).backgroundColor;x=x.parentElement;}
 o.push([c.color,bg,parseFloat(c.fontSize),e.className||e.tagName,e.textContent.trim().slice(0,34)]);}
 [...e.children].forEach(w);};w(document.body);return o;});
const bad=[];
for(const [fg,bg,size,cls,txt] of rows){const f=pr(fg),g=pr(bg);if(!f||!g)continue;
 const need=size>=24?3:4.5;const r=ct(f,g);if(r<need)bad.push([r.toFixed(2),need,size,fg,bg,cls,txt]);}
console.log(`${bad.length} failing of ${rows.length}\n`);
for(const x of bad) console.log(x.join('  |  '));
await b.close();
