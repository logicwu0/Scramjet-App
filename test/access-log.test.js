import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccessLogger,auditedSocket} from '../src/logging/access.js';
import {createSecurityLogger} from '../src/logging/security.js';
class Socket { constructor(hostname,port){this.hostname=hostname;this.port=port;} async connect() {} async close() {} }
test('socket records success once, preserves per-user context and does not log payloads', async()=>{
 const rows=[];
 const A=auditedSocket(Socket,'tcp',{account:'student1',sourceIp:'192.0.2.1'},x=>rows.push(x));
 const B=auditedSocket(Socket,'tcp',{account:'student2',sourceIp:'192.0.2.2'},x=>rows.push(x));
 const a=new A('translate.google.com',443),b=new B('mail.google.com',443);
 await Promise.all([a.connect(),b.connect()]);await a.close();await b.close();
 assert.equal(rows.length,2);assert.equal(rows[0].account,'student1');assert.equal(rows[1].account,'student2');assert.equal(rows[0].result,'connected');
});
test('failed and pre-connect closed sockets have accurate distinct outcomes',async()=>{
 const rows=[];class Failed extends Socket {async connect(){throw Error('secret destination details');}}
 const F=auditedSocket(Failed,'tcp',{},x=>rows.push(x));const a=new F('bad.invalid',443);
 await assert.rejects(a.connect());await a.close();
 const B=auditedSocket(Socket,'udp',{},x=>rows.push(x));const b=new B('blocked.example',53);await b.close();
 assert.deepEqual(rows.map(x=>x.result),['failed','not_established']);assert.doesNotMatch(JSON.stringify(rows),/secret/);
});
test('access writes only local file, security rejects successful login/logout events',()=>{
 const local=[],security=[];
 const access=createAccessLogger({file:'/local',write:(_,line)=>local.push(JSON.parse(line))});
 const audit=createSecurityLogger({file:'/security',write:(_,line)=>security.push(JSON.parse(line))});
 access({account:'student',sourceIp:'192.0.2.1',targetHost:'example.org',targetPort:443,protocol:'tcp',result:'connected'});
 audit('login_success');audit('logout_success');audit('login_failure',{reason:'invalid_callback'});
 assert.equal(local.length,1);assert.equal(security.length,1);assert.equal(security[0].event,'login_failure');assert.equal(security[0].target_host,undefined);
});
