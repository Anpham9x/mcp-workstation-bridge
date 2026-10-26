import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs/promises';
import { executeVerification } from './runVerification.js';
import { resolveCommandForProject } from '../security/index.js';

console.log('Starting Unit Tests for Run Verification Tool & Command Registry...');

// Helper to assert that a promise rejects with a specific error message substring
async function assertRejects(promise: Promise<any>, expectedMessagePart: string) {
  try {
    await promise;
    assert.fail('Expected promise to reject, but it resolved successfully.');
  } catch (err: any) {
    assert.ok(err instanceof Error, 'Expected error to be an instance of Error');
    assert.ok(
      err.message.includes(expectedMessagePart),
      `Expected error message "${err.message}" to contain "${expectedMessagePart}"`
    );
  }
}

async function runTests() {
  const currentDir = path.resolve('C:\\Users\\ExampleUser\\Documents\\mcp-antigravity-bridge');
  const scratchDir = path.join(currentDir, 'scratch');
  
  // Setup temporary test directories
  const testSubprojectDir = path.join(scratchDir, 'test-subproject-dan');
  const subprojectPackageJson = path.join(testSubprojectDir, 'package.json');
  const rustProjectDir = path.join(scratchDir, 'test-rust-project-dan');
  const cargoToml = path.join(rustProjectDir, 'Cargo.toml');
  
  const ambiguousDir = path.join(scratchDir, 'test-ambiguous-dan');
  const ambSub1 = path.join(ambiguousDir, 'sub1');
  const ambSub2 = path.join(ambiguousDir, 'sub2');
  
  const missingDir = path.resolve('C:\\Users\\ExampleUser\\Documents\\test-missing-dan');
  
  await fs.mkdir(testSubprojectDir, { recursive: true });
  // Add a mock script to package.json so executeVerification can succeed when pointing to it
  await fs.writeFile(subprojectPackageJson, JSON.stringify({
    name: 'test-subproject',
    scripts: {
      typecheck: 'echo mock_typecheck_success'
    }
  }), 'utf8');
  await fs.mkdir(rustProjectDir, { recursive: true });
  await fs.writeFile(cargoToml, '[package]\nname = "test-rust-project"\nversion = "0.1.0"\n', 'utf8');

  await fs.mkdir(ambSub1, { recursive: true });
  await fs.mkdir(ambSub2, { recursive: true });
  await fs.writeFile(path.join(ambSub1, 'package.json'), '{}', 'utf8');
  await fs.writeFile(path.join(ambSub2, 'package.json'), '{}', 'utf8');

  await fs.mkdir(missingDir, { recursive: true });

  try {
    // -------------------------------------------------------------
    // Test 1: correct cwd resolution for the current repo/project
    // -------------------------------------------------------------
    console.log('- Test 1: Verifying correct cwd resolution for the current repo/project...');
    
    // Root level contains package.json, so it should resolve directly to currentDir
    const config1 = await resolveCommandForProject('npm_typecheck', currentDir);
    assert.strictEqual(path.resolve(config1.cwd), currentDir, 'Should resolve cwd to root folder if it contains package.json');
    
    // Subproject contains package.json, should resolve downward
    const config2 = await resolveCommandForProject('npm_typecheck', scratchDir);
    assert.strictEqual(path.resolve(config2.cwd), testSubprojectDir, 'Should resolve downward to subproject containing package.json');

    // -------------------------------------------------------------
    // Test 2: fixed args are used (npm_typecheck, npm_build, git_status)
    // -------------------------------------------------------------
    console.log('- Test 2: Verifying fixed executable and arguments for npm_typecheck, npm_build, git_status...');
    assert.strictEqual(config1.command, 'npm', 'Executable must be npm');
    assert.deepStrictEqual(config1.args, ['run', 'typecheck'], 'Arguments must be fixed to ["run", "typecheck"]');

    const configBuild = await resolveCommandForProject('npm_build', currentDir);
    assert.strictEqual(configBuild.command, 'npm', 'Executable must be npm');
    assert.deepStrictEqual(configBuild.args, ['run', 'build'], 'Arguments must be fixed to ["run", "build"]');

    const configGit = await resolveCommandForProject('git_status', currentDir);
    assert.strictEqual(configGit.command, 'git', 'Executable must be git');
    assert.deepStrictEqual(configGit.args, ['status', '--short'], 'Arguments must be fixed to ["status", "--short"]');

    // -------------------------------------------------------------
    // Test 2b: supported toolchains have fixed args and bounded long timeouts
    // -------------------------------------------------------------
    console.log('- Test 2b: Verifying Python/npm/Rust registry entries and command-specific timeouts...');
    const configPytest = await resolveCommandForProject('python_pytest', currentDir);
    assert.strictEqual(configPytest.command, 'python');
    assert.deepStrictEqual(configPytest.args, ['-m', 'pytest']);
    assert.strictEqual(configPytest.timeoutMs, 15 * 60 * 1000);

    const configNpmTest = await resolveCommandForProject('npm_test', currentDir);
    assert.deepStrictEqual(configNpmTest.args, ['run', 'test']);
    assert.strictEqual(configNpmTest.timeoutMs, 15 * 60 * 1000);

    const configCargo = await resolveCommandForProject('cargo_test', rustProjectDir);
    assert.strictEqual(configCargo.command, 'cargo');
    assert.deepStrictEqual(configCargo.args, ['test']);
    assert.strictEqual(configCargo.timeoutMs, 15 * 60 * 1000);

    // -------------------------------------------------------------
    // Test 3: unknown command rejection
    // -------------------------------------------------------------
    console.log('- Test 3: Verifying unknown command rejection...');
    await assertRejects(
      resolveCommandForProject('npm_invalid_command_id_xyz', currentDir),
      "command ID 'npm_invalid_command_id_xyz' is not allowlisted"
    );

    const resultUnknown = await executeVerification(currentDir, 'npm_invalid_command_id_xyz');
    assert.strictEqual(resultUnknown.success, false, 'executeVerification must fail on invalid command ID');
    assert.ok(resultUnknown.error?.includes('is not allowlisted'), 'Error response must indicate not allowlisted');

    // -------------------------------------------------------------
    // Test 4: no arbitrary shell command injection
    // -------------------------------------------------------------
    console.log('- Test 4: Verifying shell command injection defense...');
    await assertRejects(
      resolveCommandForProject('npm_typecheck; rm -rf', currentDir),
      'is not allowlisted'
    );
    await assertRejects(
      resolveCommandForProject('npm_typecheck & dir', currentDir),
      'is not allowlisted'
    );

    const resultInj = await executeVerification(currentDir, 'npm_typecheck; echo "unsafe"');
    assert.strictEqual(resultInj.success, false, 'Should fail verification for command injection ID');
    assert.ok(resultInj.error?.includes('is not allowlisted'), 'Error should say command ID is not allowlisted');
    assert.strictEqual(resultInj.exitCode, null, 'Should not run any command');

    // -------------------------------------------------------------
    // Test 5: invalid/outside cwd rejection if a project argument exists
    // -------------------------------------------------------------
    console.log('- Test 5: Verifying outside cwd rejection with project argument...');
    
    // Relative path pointing outside roots
    const resultOutside = await executeVerification(currentDir, 'npm_typecheck', '..\\..\\..\\..\\Windows');
    assert.strictEqual(resultOutside.success, false, 'Should reject project path outside approved workspace roots');
    assert.ok(resultOutside.error?.includes('lies outside configured workspace roots'), 'Error must mention outside configured workspace roots');

    // Absolute path pointing outside roots
    const resultOutsideAbs = await executeVerification(currentDir, 'npm_typecheck', 'C:\\Users\\ExampleUser\\Downloads');
    assert.strictEqual(resultOutsideAbs.success, false, 'Should reject absolute project path outside approved roots');
    assert.ok(resultOutsideAbs.error?.includes('lies outside configured workspace roots'), 'Error must mention outside configured workspace roots');

    // -------------------------------------------------------------
    // Test 6: Ambiguous marker detection rejection
    // -------------------------------------------------------------
    console.log('- Test 6: Verifying ambiguous marker detection error...');
    await assertRejects(
      resolveCommandForProject('npm_typecheck', ambiguousDir),
      'Ambiguity error: Multiple subprojects containing'
    );

    // -------------------------------------------------------------
    // Test 7: Missing marker rejection
    // -------------------------------------------------------------
    console.log('- Test 7: Verifying missing marker rejection error...');
    await assertRejects(
      resolveCommandForProject('npm_typecheck', missingDir),
      'Could not find configuration marker'
    );

    // -------------------------------------------------------------
    // Test 8: Command config args cannot be mutated by callers
    // -------------------------------------------------------------
    console.log('- Test 8: Verifying command config args cannot be mutated by callers between resolutions...');
    const configMutate = await resolveCommandForProject('npm_typecheck', currentDir);
    configMutate.args.push('--unsafe-flag');
    
    const configNext = await resolveCommandForProject('npm_typecheck', currentDir);
    assert.deepStrictEqual(configNext.args, ['run', 'typecheck'], 'Arguments should remain immutable between resolutions');

    // -------------------------------------------------------------
    // Test 9: executeVerification uses resolved cwd rather than caller guessing cwd
    // -------------------------------------------------------------
    console.log('- Test 9: Verifying executeVerification uses resolved cwd rather than caller guessing cwd...');
    // Caller passes 'scratch' as the project. 'scratch' directory itself has no package.json.
    // The package.json exists in 'scratch/test-subproject-dan'.
    // The command registry must automatically resolve it downward to 'scratch/test-subproject-dan' and execute the command there.
    const runResult = await executeVerification(currentDir, 'npm_typecheck', 'scratch');
    assert.strictEqual(runResult.success, true, `Should execute successfully, but failed with: ${runResult.error}`);
    assert.ok(runResult.stdout.includes('mock_typecheck_success'), `Expected stdout to contain "mock_typecheck_success", got: "${runResult.stdout}"`);

    console.log('All Unit Tests for Run Verification Tool & Command Registry Passed Successfully!');
  } finally {
    // Cleanup temporary test directories and files
    try {
      await fs.unlink(subprojectPackageJson);
      await fs.rm(testSubprojectDir, { recursive: true, force: true });
      await fs.unlink(cargoToml);
      await fs.rm(rustProjectDir, { recursive: true, force: true });
    } catch (e) {}

    try {
      await fs.unlink(path.join(ambSub1, 'package.json'));
      await fs.unlink(path.join(ambSub2, 'package.json'));
      await fs.rm(ambiguousDir, { recursive: true, force: true });
    } catch (e) {}

    try {
      await fs.rm(missingDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

runTests().catch(err => {
  console.error('Unit Test Failed with error:', err);
  process.exit(1);
});
