import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
const root=import.meta.resolve('@mercuryworkshop/wisp-js/server');
const {AsyncQueue}=await import(new URL('../websocket.mjs',root));
const {NodeTCPSocket}=await import(new URL('../server/net.mjs',root));

test('TCP EOF preserves queued chunks before end marker',async()=>{
 const q=new AsyncQueue(10);await q.put(Buffer.from('first'));await q.put(Buffer.from('last'));
 q.close(true);
 assert.equal((await q.get()).toString(),'first');assert.equal((await q.get()).toString(),'last');assert.equal(await q.get(),null);
});
test('EOF follows producers waiting on a full queue',async()=>{
 const q=new AsyncQueue(0);await q.put('one');const two=q.put('two'),three=q.put('three');
 assert.equal(q.put_callbacks.length,2);q.close(true);await Promise.all([two,three]);
 assert.equal(await q.get(),'one');assert.equal(await q.get(),'two');assert.equal(await q.get(),'three');assert.equal(await q.get(),null);
});
test('default abort still discards buffered data and releases waiters',async()=>{
 const q=new AsyncQueue(1);await q.put('discard');q.close();assert.equal(q.size,0);
 const pending=q.get();q.close();assert.equal(await pending,undefined);
});
test('real TCP close retains a complete response for a slower consumer',{timeout:10000},async t=>{
 const expected=Buffer.alloc(1024*1024,0x5a);
 const server=createServer(socket=>socket.end(expected));
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const client=new NodeTCPSocket('127.0.0.1',server.address().port);await client.connect();
 const socket=client.socket;await once(socket,'close');
 const chunks=[];for(;;){const chunk=await client.recv();if(chunk==null)break;chunks.push(chunk);}
 assert.deepEqual(Buffer.concat(chunks),expected);
});
