import assert from 'node:assert/strict';
import { patchBytes } from './bytePatch.js';
const fixture = 'RUN=r1416\nOWNER=Người Dùng\nMODE=v1\n';
const patch = '--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1,3 +1,3 @@\n RUN=r1416\n OWNER=Người Dùng\n-MODE=v1\n+MODE=v2\n';
for (const before of [fixture, fixture.replace(/\n/g, '\r\n'),
  'RUN=r1416\r\nOWNER=Người Dùng\nMODE=v1\r\n',
  '\uFEFF' + fixture, '\uFEFF' + fixture.replace(/\n/g, '\r\n')]) {
  const input = Buffer.from(before);
  assert.deepEqual(patchBytes(input, patch), Buffer.from(before.replace('MODE=v1','MODE=v2')));
  assert.deepEqual(input, Buffer.from(before)); // Planner cannot mutate dry-run input.
  assert.throws(() => patchBytes(input, patch.replace('-MODE=v1','-MODE=v9')), /CONTEXT_MISMATCH/);
}
const noFinal = fixture.slice(0,-1);
const noFinalPatch = patch.replace('-MODE=v1\n+MODE=v2\n',
  '-MODE=v1\n\\ No newline at end of file\n+MODE=v2\n\\ No newline at end of file\n');
assert.deepEqual(patchBytes(Buffer.from(noFinal), noFinalPatch), Buffer.from(noFinal.replace('v1','v2')));
assert.deepEqual(patchBytes(null, '--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,1 @@\n+hello\n'), Buffer.from('hello\n'));
assert.throws(() => patchBytes(Buffer.from([0xff]), patch));
assert.throws(() => patchBytes(Buffer.from(fixture), patch+patch), /SINGLE_FILE_ONLY/);
assert.throws(() => patchBytes(Buffer.from(fixture), patch.replace('@@ -1,3 +1,3 @@','@@ -1,4 +1,3 @@')), /COUNT/);
assert.throws(() => patchBytes(Buffer.from(fixture), patch+'new mode 100755\n'), /UNSUPPORTED/);
assert.deepEqual(patchBytes(Buffer.from('\uFEFF'+fixture),patch.replace(' RUN=r1416',' \uFEFFRUN=r1416')),Buffer.from('\uFEFF'+fixture.replace('v1','v2')));
console.log('bytePatch: LF/CRLF/mixed/BOM/Unicode/no-final/create/context/count/format PASS');

