import fs from 'node:fs';
export async function journey({page,step,expect,note}) {
 const b=JSON.parse(fs.readFileSync(process.env.LIVE_AUTOSAVE_BENCH_FILE,'utf8'));
 const weak=Boolean(process.env.MOBILE_STATUS_EXPECT_WEAK);
 page.on('dialog',d=>d.accept(b.editToken));
 await page.goto(b.url+'?edit&shot=1');
 await page.getByRole('button',{name:'Edit page'}).click();
 await page.route('**/api/save',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic temporary refusal'})}));
 const text='Phone writing stays safe when autosave is refused 🙂';
 await page.locator('h1').fill(text);
 await page.waitForFunction(()=>/retrying automatically/.test(document.querySelector('#cms-status').textContent));
 const read=()=>JSON.parse(fs.readFileSync(b.contentPath,'utf8'));
 expect(read().hero.headline!==text,'the refused content was never called committed');
 expect(await page.evaluate(t=>Object.keys(localStorage).some(k=>k.startsWith('plater.buf.')&&JSON.parse(localStorage.getItem(k)).content.hero.headline===t),text),'whole writing is in local recovery');
 const rects=await page.evaluate(()=>{
  const view={left:visualViewport.offsetLeft,right:visualViewport.offsetLeft+visualViewport.width};
  const rect=e=>{const r=e.getBoundingClientRect();return {text:e.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
  return {view,status:rect(document.querySelector('#cms-status')),buttons:[...document.querySelectorAll('#cms-bar button')].filter(e=>e.getClientRects().length).map(rect)};
 });
 const inside=r=>r.left>=rects.view.left&&r.right<=rects.view.right;
 expect(weak?!inside(rects.status):inside(rects.status),'temporary failure and recovery status stays inside the phone viewport after the fix');
 if(!weak) expect(rects.buttons.every(inside),'every visible toolbar button is reachable without horizontal scrolling');
 note('Real refusal, preserved content and viewport read-backs',rects);
 await step(weak?'phone hides the autosave failure offscreen':'phone shows the refusal, recovery copy and reachable controls');
}
