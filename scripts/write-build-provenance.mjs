import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const files={};
async function walk(dir){
 for(const entry of await fs.readdir(path.join(root,dir),{withFileTypes:true})){
  const relative=dir+'/'+entry.name;
  if(entry.isSymbolicLink())throw new Error('Build input symlink rejected');
  if(entry.isDirectory())await walk(relative);
  else if(/\.(ts|js|json)$/.test(entry.name))files[relative]=sha(await fs.readFile(path.join(root,relative)));
 }
}
await walk('src');await walk('dist');
const sourceHead=execFileSync('git',['-c','safe.directory='+root,'rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const buildId=sha(Buffer.from(JSON.stringify(files)));
await fs.mkdir(path.join(root,'.ai'),{recursive:true});
await fs.writeFile(path.join(root,'.ai/build-provenance.json'),JSON.stringify({schemaVersion:1,buildId,builtAt:new Date().toISOString(),sourceHead,files},null,2));
console.log('Build provenance '+buildId+' files='+Object.keys(files).length);

