import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
export async function journey({page,step,expect,note}) {
 const weak=Boolean(process.env.PROMOTION_EXPECT_WEAK);
 const b=JSON.parse(fs.readFileSync(process.env.PROMOTION_BENCH_FILE,'utf8'));
 const git=(...a)=>execFileSync('git',['-C',b.siteDir,...a],{encoding:'utf8'}).trim();
 const original=JSON.parse(fs.readFileSync(b.contentPath,'utf8'));
 const overlay=path.join(b.siteDir,'content/versions/audit/site.json');
 fs.mkdirSync(path.dirname(overlay),{recursive:true});
 fs.writeFileSync(overlay,JSON.stringify({hero:{headline:'Draft headline intentionally changed'}}));
 git('add','content/versions/audit/site.json');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic sparse draft');
 page.on('dialog',d=>d.accept(b.editToken));
 await page.goto(b.url+'?edit&draft=audit&shot=1');
 await page.locator('h1[contenteditable=true]').waitFor();
 await expect.text('h1','Draft headline intentionally changed');
 const remote=structuredClone(original);remote.hero.subhead='New live paragraph committed while the draft is open';remote.remoteOnly='A wholly new live field';
 fs.writeFileSync(b.contentPath,JSON.stringify(remote,null,2));git('add','content/site.json');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Synthetic newer live paragraph');
 const remoteSha=git('rev-parse','HEAD');
 // A deployed site still serves its previous snapshot while GitHub is ahead.
 fs.writeFileSync(b.contentPath,JSON.stringify(original,null,2));
 await step('draft is open while another editor commits a newer live paragraph');
 const response=page.waitForResponse(r=>r.url().endsWith('/api/save')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'⬆ Make this live'}).click();
 const r=await response;const out=await r.json();
 const stored=JSON.parse(git('show','HEAD:content/site.json'));
 const lost=stored.hero.subhead!==remote.hero.subhead;
 if (!weak) {
  expect(r.status()===409 && git('rev-parse','HEAD')===remoteSha,'stale promotion refuses without changing the newer live commit');
  note('Stale promotion refused', {status:r.status(),out,remoteSha,head:git('rev-parse','HEAD'),newerParagraph:stored.hero.subhead});
  await page.waitForFunction(()=>/Reload and review/.test(document.querySelector('#cms-status').textContent));
  await step('stale promotion refuses and keeps the draft and live commit');
  const legacy=await fetch(b.url+'api/save',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+b.editToken},body:JSON.stringify({promote:'audit',content:original})});
  expect(legacy.status===409&&git('rev-parse','HEAD')===remoteSha,'old clients without a live baseline also fail closed');
  fs.writeFileSync(b.contentPath,JSON.stringify(remote,null,2));
  await page.reload(); await page.locator('h1[contenteditable=true]').waitFor();
  await expect.text('[data-bind="hero.subhead"]',remote.hero.subhead);
  const next=page.waitForResponse(x=>x.url().endsWith('/api/save')&&x.request().method()==='POST');
  await page.getByRole('button',{name:'⬆ Make this live'}).click(); const accepted=await next;
  const final=JSON.parse(git('show','HEAD:content/site.json'));
  expect(accepted.status()===200&&final.hero.subhead===remote.hero.subhead&&final.hero.headline==='Draft headline intentionally changed','reviewed fresh promotion preserves the newer live paragraph and promotes the draft headline');
  note('Fresh reviewed promotion accepted',{status:accepted.status(),head:git('rev-parse','HEAD'),content:final.hero,legacyStatus:legacy.status});
  await page.getByRole('button',{name:'LIVE ✓'}).waitFor();
  await step('fresh reviewed promotion succeeds with both editors text');
  if (process.env.PROMOTION_DEV_BENCH_FILE) {
   const dev=JSON.parse(fs.readFileSync(process.env.PROMOTION_DEV_BENCH_FILE,'utf8'));
   const base=JSON.parse(fs.readFileSync(dev.contentPath,'utf8'));
   const current=structuredClone(base);current.hero.subhead='A newer local live paragraph';
   fs.writeFileSync(dev.contentPath,JSON.stringify(current,null,2));
   const proposed={...current,hero:{...current.hero,headline:'Local promoted draft headline'}};
   const post=async(body)=>{const res=await fetch(dev.url+'api/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:res.status,out:await res.json()};};
   const stale=await post({promote:'audit',content:proposed,liveBase:base});
   const missing=await post({promote:'audit',content:proposed});
   expect(stale.status===409&&missing.status===409&&fs.readFileSync(dev.contentPath,'utf8')===JSON.stringify(current,null,2),'actual dev promotion refuses both stale and missing baselines without changing disk');
   const fresh=await post({promote:'audit',content:proposed,liveBase:current});
   const storedDev=JSON.parse(fs.readFileSync(dev.contentPath,'utf8'));
   expect(fresh.status===200&&storedDev.hero.subhead===current.hero.subhead&&storedDev.hero.headline===proposed.hero.headline,'actual dev promotion with a current baseline keeps both fields');
   note('Local dev HTTP and disk read-backs',{stale,missing,fresh,stored:storedDev.hero});
  }
  return;
 }
 expect(r.status()===200&&lost,'repro: promotion acknowledges success while overwriting the unrelated newer paragraph');
 expect(stored.remoteOnly===remote.remoteOnly,'top-level unknown fields survive, unlike nested siblings');
 note('Actual promotion response and local git read-back',{status:r.status(),out,remoteSha,head:git('rev-parse','HEAD'),beforeParagraph:remote.hero.subhead,afterParagraph:stored.hero.subhead,draftHeadline:stored.hero.headline,newTopLevelFieldKept:stored.remoteOnly===remote.remoteOnly});
 await page.getByRole('button',{name:'LIVE ✓'}).waitFor();
 await step('promotion says live but replaces the newer paragraph');
}
