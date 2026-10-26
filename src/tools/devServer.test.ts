import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { devServerLogs, devServerStart, devServerStop, listDevServers } from './devServer.js';
import { browserDomSnapshot, snapshotHtml } from './browserDom.js';

console.log('Bắt đầu chạy Unit Test cho Dev Server và DOM Snapshot Tools...');

const fixtureRoot = path.resolve('tmp-dev-server-test');
const port = 58731;

async function resetFixture(): Promise<void> {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, 'package.json'),
    JSON.stringify({
      name: 'dev-server-fixture',
      scripts: {
        dev: 'node server.mjs',
        start: 'node server.mjs',
        preview: 'node server.mjs',
        lint: 'node server.mjs'
      }
    }, null, 2),
    'utf8'
  );
  await fs.writeFile(path.join(fixtureRoot, 'package-lock.json'), '{}\n', 'utf8');
  await fs.writeFile(
    path.join(fixtureRoot, 'server.mjs'),
    [
      'import http from "node:http";',
      'const port = Number(process.env.PORT || 5173);',
      'const server = http.createServer((req, res) => {',
      '  res.setHeader("content-type", "text/html; charset=utf-8");',
      '  res.end(`<main id="app"><h1 class="title">Fixture Ready</h1><input type="password" value="super-secret-password"><button data-token="abc123456789">Save</button></main>`);',
      '});',
      'server.listen(port, "127.0.0.1", () => console.log(`fixture listening ${port}`));'
    ].join('\n'),
    'utf8'
  );
}

function startExternalServer(testPort: number): Promise<http.Server> {
  const server = http.createServer((_, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<p>external</p>');
  });
  return new Promise(resolve => server.listen(testPort, '127.0.0.1', () => resolve(server)));
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function runTests(): Promise<void> {
  await resetFixture();
  let serverId: string | null = null;
  try {
    console.log('- Kiểm tra chặn stop server không thuộc registry...');
    await assert.rejects(
      () => devServerStop({ serverId: 'not-managed-by-bridge' }),
      /DEV_SERVER_NOT_FOUND/
    );

    console.log('- Kiểm tra chặn port conflict trước khi spawn...');
    const external = await startExternalServer(port + 1);
    try {
      await assert.rejects(
        () => devServerStart({ workspacePath: fixtureRoot, script: 'dev', port: port + 1, timeoutMs: 3000 }),
        /DEV_SERVER_PORT_IN_USE/
      );
    } finally {
      await closeServer(external);
    }

    console.log('- Kiểm tra start/list/logs/DOM snapshot/stop lifecycle...');
    const started = await devServerStart({ workspacePath: fixtureRoot, script: 'dev', port, timeoutMs: 30000 });
    serverId = started.id;
    assert.strictEqual(started.status, 'ready');
    assert.ok(started.pid, 'dev server phải có pid');
    assert.ok(listDevServers().some(server => server.id === started.id), 'list_dev_servers phải thấy server đang quản lý');

    const logs = devServerLogs({ serverId: started.id, maxLines: 10 });
    assert.ok(logs.lines.some(line => line.includes('fixture listening')), 'logs phải có output bounded của server');

    const snapshot = await browserDomSnapshot({ url: started.url, selector: '.title', maxNodes: 10 });
    assert.strictEqual(snapshot.nodeCount, 1);
    assert.strictEqual(snapshot.nodes[0].text, 'Fixture Ready');

    const passwordSnapshot = await browserDomSnapshot({ url: started.url, selector: 'input', maxNodes: 10 });
    assert.strictEqual(passwordSnapshot.nodes[0].attributes?.value, '[REDACTED]');

    const stopped = await devServerStop({ serverId: started.id });
    serverId = null;
    assert.strictEqual(stopped.status, 'stopped');
    assert.strictEqual(listDevServers().some(server => server.id === started.id), false, 'server đã stop phải rời registry');

    console.log('- Kiểm tra snapshotHtml giới hạn node và local URL guard...');
    const manyNodes = snapshotHtml({
      html: '<section><p>A</p><p>B</p><p>C</p></section>',
      selector: 'p',
      maxNodes: 2
    });
    assert.strictEqual(manyNodes.nodes.length, 2);
    assert.strictEqual(manyNodes.truncated, true);
    await assert.rejects(
      () => browserDomSnapshot({ url: 'https://example.com/' }),
      /only localhost/
    );

    console.log('Tất cả Unit Test Dev Server và DOM Snapshot đều đạt (PASSED)!');
  } finally {
    if (serverId) {
      await devServerStop({ serverId }).catch(() => undefined);
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

runTests().catch(error => {
  console.error('Unit test thất bại:', error);
  process.exit(1);
});
