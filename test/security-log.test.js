import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecurityLogger, sourceIp } from '../src/logging/security.js';

test('security records are single-line, schema-limited, and contain no request secrets', t => {
 const dir=mkdtempSync(join(tmpdir(),'webvpn-audit-'));t.after(()=>rmSync(dir,{recursive:true}));
 const file=join(dir,'security.jsonl');const log=createSecurityLogger({file});
 log('login_failure',{account:'student\nforged',sourceIp:'192.0.2.5',result:'failure',reason:'invalid_callback',ticket:'ST-secret',cookie:'secret',url:'https://private.example/path'});
 const lines=readFileSync(file,'utf8').trim().split('\n');assert.equal(lines.length,1);
 const entry=JSON.parse(lines[0]);assert.equal(entry.account,'student forged');assert.equal(entry.source_ip,'192.0.2.5');
 assert.equal(entry.category,'authentication_security');assert.ok(entry.event_id);
 assert.doesNotMatch(lines[0],/ST-secret|cookie|private.example/);
});
test('only explicit loopback proxy trust accepts a single validated X-Real-IP', () => {
 const req={socket:{remoteAddress:'127.0.0.1'},headers:{'x-real-ip':'192.0.2.7','x-forwarded-for':'198.51.100.1'}};
 assert.equal(sourceIp(req), '127.0.0.1');assert.equal(sourceIp(req,true),'192.0.2.7');
 req.socket.remoteAddress='203.0.113.8';assert.equal(sourceIp(req,true),'203.0.113.8');
 req.socket.remoteAddress='127.0.0.1';req.headers['x-real-ip']='192.0.2.7, 198.51.100.1';assert.equal(sourceIp(req,true),'127.0.0.1');
});
test('disk failure preserves event in fallback without throwing or exposing the error', () => {
 const lines=[];const log=createSecurityLogger({file:'/unused',write:()=>{throw Error('secret');},fallback:x=>lines.push(x)});
 assert.doesNotThrow(()=>log('proxy_error',{reason:'client_socket_error'}));assert.equal(lines.length,1);assert.match(lines[0],/proxy_error/);assert.doesNotMatch(lines[0],/secret/);
});
