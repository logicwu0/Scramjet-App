import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2] || '.');
const manifest = JSON.parse(readFileSync(join(root,'DEPLOYED_MANIFEST.json'),'utf8'));
const failures=[];
if (!/^[a-f0-9]{40}$/.test(manifest.commit)) throw Error('Invalid deployment commit');
for (const [file,expected] of Object.entries({...manifest.files,...JSON.parse(readFileSync(join(root,'deploy/runtime-integrity.json'),'utf8'))})) {
 const full=resolve(root,file);
 if (!full.startsWith(root+'/')) throw Error('Unsafe manifest path');
 try {
  const actual=createHash('sha256').update(readFileSync(full)).digest('hex');
  if(actual!==expected) failures.push(`changed: ${file}`);
 } catch {failures.push(`missing: ${file}`);}
}
for(const folder of ['src','public','scripts','test','docs','deploy','patches']) {
 function walk(dir) {
  for(const entry of readdirSync(dir)) {
   const full=join(dir,entry),name=relative(root,full);
   if(lstatSync(full).isDirectory())walk(full);
   else if(!(name in manifest.files))failures.push(`untracked: ${name}`);
  }
 }
 walk(join(root,folder));
}
if(readFileSync(join(root,'DEPLOYED_COMMIT'),'utf8').trim()!==manifest.commit)failures.push('deployment version marker differs');
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log(`PASS ${manifest.commit}: ${Object.keys(manifest.files).length} source files and pinned runtime fingerprints match`);
