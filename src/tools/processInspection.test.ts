import assert from 'node:assert';
import { listLocalPorts, listWorkspaceProcesses } from './processInspection.js';

async function run(): Promise<void> {
  const processes = await listWorkspaceProcesses('C:\\Users\\ExampleUser\\Documents\\mcp-antigravity-bridge');
  assert.ok(Array.isArray(processes));
  for (const process of processes as any[]) {
    assert.ok(!('CommandLine' in process));
    assert.ok(!('Environment' in process));
  }
  const ports = await listLocalPorts();
  assert.ok(Array.isArray(ports));
  console.log(`Process/port inspection passed (${processes.length} filtered processes, ${ports.length} ports).`);
}

run().catch(error => { console.error(error); process.exit(1); });
