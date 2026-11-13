import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {sanitizeNavigationURL} from '../public/navigation-policy.mjs';
import {createNavigationReporter,sourceFromReferrer} from '../public/navigation-log.mjs';
import {registerNavigationLogging} from '../src/logging/navigation.js';

test('Google terms and article paths retained; credentials and unknown query values removed',()=>{
 const row=sanitizeNavigationURL('https://user:password@www.google.com/search?q=南昌大学&token=SECRET&unknown=PRIVATE#access_token=BAD');
 assert.equal(row.search_query,'南昌大学'); assert.equal(row.redacted,true);
 assert.doesNotMatch(JSON.stringify(row),/SECRET|PRIVATE|BAD|password/);
 assert.equal(sanitizeNavigationURL('https://journal.example/article/123?doi=10.1%2Fabc&page=2').url,'https://journal.example/article/123?doi=10.1%2Fabc&page=2');
 assert.equal(sanitizeNavigationURL('javascript:alert(1)'),null);
 assert.equal(sanitizeNavigationURL('https://accounts.google.com/signin?email=private').url,'https://accounts.google.com/[redacted]');
 assert.equal(sanitizeNavigationURL('https://google.com.evil.example/search?q=term').search_query,null);
});
test('reporter associates previous search with observed target, dedups and sanitizes before sending',async()=>{
 const reports=[]; const reporter=createNavigationReporter({send:x=>reports.push(x),uuid:()=> 'test-event-1234567890',now:()=>100000});
 reporter.observe('https://www.google.com/search?q=test&token=SECRET');
 reporter.observe('https://www.google.com/search?q=test&token=SECRET');
 reporter.observe('https://journal.example/article/123?session=PRIVATE&id=42');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reports.length,2);assert.match(reports[1].source_url,/google.com\/search\?q=test/);
 assert.equal(reports[1].target_url,'https://journal.example/article/123?id=42');
 assert.doesNotMatch(JSON.stringify(reports),/SECRET|PRIVATE/);
 assert.equal(sourceFromReferrer('https://vpn.example/web/'+encodeURIComponent('https://www.google.com/search?q=term'),'https://vpn.example'),'https://www.google.com/search?q=term');
 assert.equal(sourceFromReferrer('https://other.example/web/anything','https://vpn.example'),null);
});
test('navigation API authenticates, binds identity, sanitizes, dedups and never trusts body identity',async t=>{
 const app=Fastify(),rows=[];t.after(()=>app.close());
 const auth={accessContext:req=>req.headers.cookie==='session=valid'?{account:'real-student',sourceIp:'192.0.2.1'}:null};
 registerNavigationLogging(app,auth,'https://vpn.example',{enabled:true,file:'test-only',write:(_,line)=>rows.push(JSON.parse(line)),now:()=>100000});
 const payload={event_id:'test-event-1234567890',target_url:'https://journal.example/article/42?token=SECRET&id=42',source_url:'https://www.google.com/search?q=南昌大学',account:'forged',source_ip:'127.0.0.1'};
 assert.equal((await app.inject({method:'POST',url:'/api/navigation-log',payload})).statusCode,401);
 assert.equal((await app.inject({method:'POST',url:'/api/navigation-log',headers:{cookie:'session=valid'},payload})).statusCode,403);
 const req={method:'POST',url:'/api/navigation-log',headers:{cookie:'session=valid',origin:'https://vpn.example'},payload};
 assert.equal((await app.inject(req)).statusCode,204);assert.equal((await app.inject(req)).statusCode,204);
 assert.equal(rows.length,1); assert.equal(rows[0].account,'real-student');assert.equal(rows[0].source_ip,'192.0.2.1');
 assert.equal(rows[0].source_search_query,'南昌大学');assert.equal(rows[0].evidence_source,'browser_report');
 assert.doesNotMatch(JSON.stringify(rows),/SECRET|forged/);
 for(let i=0;i<118;i++)await app.inject({...req,payload:{...payload,event_id:'test-event-'+String(i).padStart(12,'0')}});
 assert.equal((await app.inject({...req,payload:{...payload,event_id:'test-event-overlimit'}})).statusCode,429);
});
test('navigation API remains off without explicit switch; write failures are visible to reporter',async t=>{
 for(const enabled of [false,true]){
 const app=Fastify();t.after(()=>app.close());
 registerNavigationLogging(app,{accessContext:()=>({account:'student',sourceIp:'192.0.2.1'})},'https://vpn.example',{enabled,file:'test',write:()=>{throw Error('disk');}});
 assert.equal((await app.inject('/api/navigation-config')).json().enabled,enabled);
 const res=await app.inject({method:'POST',url:'/api/navigation-log',headers:{origin:'https://vpn.example'},payload:{event_id:'test-event-1234567890',target_url:'https://www.google.com/search?q=test'}});
 assert.equal(res.statusCode,enabled?503:204);
 }
});
