import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {registerProxyDiagnostics} from '../src/proxy-diagnostics.js';

test('diagnostics accept only bounded safe fields and require same origin', async t=>{
 const app=Fastify(), records=[];t.after(()=>app.close());
 registerProxyDiagnostics(app,'https://vpn.example',{write:s=>records.push(s),now:()=>100000});
 const payload={host:'www.google.com.hk',page:'search',status:429,destination:'document',site:'same-origin',mode:'navigate',cookieCount:5,hasAuthorization:false,cookie:'secret-cookie',query:'private-search',account:'student'};
 assert.equal((await app.inject({method:'POST',url:'/api/proxy-diagnostics',payload})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/api/proxy-diagnostics',headers:{origin:'https://vpn.example'},payload})).statusCode,204);
 assert.equal(records.length,1); assert.doesNotMatch(records[0],/secret-cookie|private-search|student/);
 assert.match(records[0],/"status":429/);
 for(let i=0;i<59;i++)await app.inject({method:'POST',url:'/api/proxy-diagnostics',headers:{origin:'https://vpn.example'},payload});
 assert.equal((await app.inject({method:'POST',url:'/api/proxy-diagnostics',headers:{origin:'https://vpn.example'},payload})).statusCode,429);
});
test('service worker diagnostic never transmits query or credential values', async()=>{
 const handlers={},sent=[];
 const context={self:{},fetch:async(url,opts)=>{sent.push({url,...opts});return{};}};
 vm.runInNewContext(readFileSync(new URL('../public/search-diagnostics.js',import.meta.url),'utf8'),context);
 context.self.webvpnSearchDiagnostics({addEventListener:(type,fn)=>handlers[type]=fn});
 const url=new URL('https://www.google.com.hk/search?q=private-search');
 handlers.request({url,requestHeaders:{Cookie:'SID=secret-cookie; NID=other',Authorization:'Basic private-credential','Sec-Fetch-Dest':'document','Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'navigate'}});
 handlers.handleResponse({url,status:429});
 assert.equal(sent.length,2);assert.equal(JSON.parse(sent[0].body).cookieCount,2);
 assert.doesNotMatch(JSON.stringify(sent),/secret-cookie|private-search|private-credential/);
});
test('captcha endpoints report only category and omit site keys and tokens',()=>{
 const handlers={},sent=[];
 const context={self:{},fetch:async(url,opts)=>{sent.push(JSON.parse(opts.body));return{};}};
 vm.runInNewContext(readFileSync(new URL('../public/search-diagnostics.js',import.meta.url),'utf8'),context);
 context.self.webvpnSearchDiagnostics({addEventListener:(type,fn)=>handlers[type]=fn});
 for(const [address,category] of [['https://www.google.com/recaptcha/api2/anchor?k=private-key','captcha-frame'],['https://www.google.com/recaptcha/api2/reload?k=private-key','captcha-verify'],['https://www.gstatic.com/recaptcha/releases/version/recaptcha__zh.js','captcha-script']]){
  const url=new URL(address);handlers.request({url,requestHeaders:{}});handlers.handleResponse({url,status:200});assert.equal(sent.at(-1).page,category);
 }
 assert.equal(sent.length,6);assert.doesNotMatch(JSON.stringify(sent),/private-key|releases|anchor|reload/);
});
test('captcha origin diagnostic reports classification, never the encoded origin',()=>{
 const handlers={},sent=[];
 const context={self:{location:{origin:'https://vpn.example'}},atob,URL,fetch:async(url,opts)=>{sent.push(JSON.parse(opts.body));return{};}};
 vm.runInNewContext(readFileSync(new URL('../public/search-diagnostics.js',import.meta.url),'utf8'),context);
 context.self.webvpnSearchDiagnostics({addEventListener:(type,fn)=>handlers[type]=fn});
 for(const [origin,expected] of [['https://vpn.example:443','portal'],['https://www.google.com:443','google']]){
  const url=new URL('https://www.google.com/recaptcha/api2/anchor');url.searchParams.set('co',btoa(origin).replace(/=/g,'.'));
  handlers.request({url,requestHeaders:{}});assert.equal(sent.at(-1).captchaOrigin,expected);
 }
 assert.doesNotMatch(JSON.stringify(sent),/vpn.example|aHR0/);
});
