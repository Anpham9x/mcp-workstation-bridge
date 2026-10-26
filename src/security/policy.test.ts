import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  checkForbiddenFile,
  isIgnoredPath,
  isBinaryExtension,
  isBinaryBuffer,
  validatePathForRead,
  validatePathForWrite,
  MAX_READ_FILE_SIZE,
  redactSensitiveData,
  ALLOWED_WORKSPACE_ROOTS,
  evaluateWorkspacePolicy,
  assertAllowedDevServerScript,
  assertLocalBrowserUrl,
  assertSafePackageSpec,
  validateProjectBridgeConfig
} from './policy.js';
import { tailLogFile, sanitizeJob } from '../runner/task.js';

console.log('Starting Security Policy Unit Tests...');

// Helper to assert that an operation throws a security error
function assertThrowsSecurityError(fn: () => void, expectedMessagePart: string) {
  try {
    fn();
    assert.fail('Expected function to throw a security error, but it succeeded.');
  } catch (err: any) {
    assert.ok(err instanceof Error, 'Expected error to be an instance of Error');
    assert.ok(
      err.message.includes(expectedMessagePart),
      `Expected error message "${err.message}" to contain "${expectedMessagePart}"`
    );
  }
}

// 1. Test MAX_READ_FILE_SIZE
console.log('- Testing MAX_READ_FILE_SIZE...');
assert.strictEqual(MAX_READ_FILE_SIZE, 5 * 1024 * 1024, 'MAX_READ_FILE_SIZE should be 5MB');

// 2. Test checkForbiddenFile
console.log('- Testing checkForbiddenFile...');
assert.strictEqual(checkForbiddenFile(''), true, 'Empty file path should be forbidden (fail-closed)');
assert.strictEqual(checkForbiddenFile('.env'), true, '.env should be forbidden');
assert.strictEqual(checkForbiddenFile('.env.production'), true, '.env.production should be forbidden');
assert.strictEqual(checkForbiddenFile('secrets.json'), true, 'secrets.json should be forbidden');
assert.strictEqual(checkForbiddenFile('id_rsa'), true, 'id_rsa should be forbidden');
assert.strictEqual(checkForbiddenFile('id_rsa.pub'), true, 'id_rsa.pub should be forbidden');
assert.strictEqual(checkForbiddenFile('.npmrc'), true, '.npmrc should be forbidden');
assert.strictEqual(checkForbiddenFile('.git-credentials'), true, '.git-credentials should be forbidden');
assert.strictEqual(checkForbiddenFile('safe_file.txt'), false, 'safe_file.txt should be allowed');

// 3. Test isIgnoredPath
console.log('- Testing isIgnoredPath...');
assert.strictEqual(isIgnoredPath(''), true, 'Empty path should be ignored (fail-closed)');
assert.strictEqual(isIgnoredPath('node_modules/lodash/index.js'), true, 'node_modules paths should be ignored');
assert.strictEqual(isIgnoredPath('src/.git/config'), true, '.git paths should be ignored');
assert.strictEqual(isIgnoredPath('dist/server.js'), true, 'dist paths should be ignored');
assert.strictEqual(isIgnoredPath('logs/autostart/log.txt'), true, 'logs paths should be ignored');
assert.strictEqual(isIgnoredPath('src/security/policy.ts'), false, 'Regular source paths should not be ignored');

// 4. Test isBinaryExtension
console.log('- Testing isBinaryExtension...');
assert.strictEqual(isBinaryExtension(''), true, 'Empty extension check should fail-closed');
assert.strictEqual(isBinaryExtension('image.png'), true, '.png should be binary');
assert.strictEqual(isBinaryExtension('archive.zip'), true, '.zip should be binary');
assert.strictEqual(isBinaryExtension('document.pdf'), true, '.pdf should be binary');
assert.strictEqual(isBinaryExtension('program.exe'), true, '.exe should be binary');
assert.strictEqual(isBinaryExtension('code.ts'), false, '.ts should not be binary');
assert.strictEqual(isBinaryExtension('README.md'), false, '.md should not be binary');

// 5. Test isBinaryBuffer
console.log('- Testing isBinaryBuffer...');
// Empty buffer is considered safe
assert.strictEqual(isBinaryBuffer(Buffer.alloc(0)), false, 'Empty buffer should be non-binary');
// Safe text buffer
const textBuffer = Buffer.from('Hello, security policy validator!');
assert.strictEqual(isBinaryBuffer(textBuffer), false, 'Text buffer should be non-binary');
// Binary buffer containing null byte \0
const binaryBuffer = Buffer.from([72, 101, 108, 108, 111, 0, 87, 111, 114, 108, 100]); // "Hello\0World"
assert.strictEqual(isBinaryBuffer(binaryBuffer), true, 'Buffer containing null byte should be binary');

// 6. Test validatePathForRead
console.log('- Testing validatePathForRead...');
const allowedRoots = [path.resolve('C:\\Users\\ExampleUser\\Documents')];
assert.deepStrictEqual(ALLOWED_WORKSPACE_ROOTS,
  (process.env.MCP_WORKSPACE_ROOTS || process.cwd()).split(path.delimiter).filter(Boolean).map(root => path.resolve(root))
);

// Valid read path
const validPath = path.resolve('C:\\Users\\ExampleUser\\Documents\\safe_project\\main.ts');
assert.strictEqual(validatePathForRead(validPath, allowedRoots), validPath);
const configuredPath = path.join(ALLOWED_WORKSPACE_ROOTS[0], 'safe_project', 'README.md');
assert.strictEqual(validatePathForRead(configuredPath), configuredPath);
assertThrowsSecurityError(
  () => validatePathForRead('D:\\Downloads\\outside.txt'),
  'lies outside configured workspace roots'
);

// Path traversal attempting escape
assertThrowsSecurityError(
  () => validatePathForRead('C:\\Users\\ExampleUser\\Documents\\..\\escaped.txt', allowedRoots),
  'lies outside configured workspace roots'
);

// Forbidden file path
assertThrowsSecurityError(
  () => validatePathForRead('C:\\Users\\ExampleUser\\Documents\\safe_project\\.env', allowedRoots),
  'is a forbidden secret or credential store'
);

// Ignored folder path
assertThrowsSecurityError(
  () => validatePathForRead('C:\\Users\\ExampleUser\\Documents\\safe_project\\node_modules\\index.js', allowedRoots),
  'lies within an ignored directory'
);

// Binary file by extension
assertThrowsSecurityError(
  () => validatePathForRead('C:\\Users\\ExampleUser\\Documents\\safe_project\\logo.png', allowedRoots),
  'Reading binary file'
);

// 7. Test validatePathForWrite
console.log('- Testing validatePathForWrite...');
// Valid write path
assert.strictEqual(validatePathForWrite(validPath, allowedRoots), validPath);

// Forbidden write file
assertThrowsSecurityError(
  () => validatePathForWrite('C:\\Users\\ExampleUser\\Documents\\safe_project\\credentials.json', allowedRoots),
  'Writing to forbidden file'
);

// Ignored folder write
assertThrowsSecurityError(
  () => validatePathForWrite('C:\\Users\\ExampleUser\\Documents\\safe_project\\.git\\HEAD', allowedRoots),
  'Writing to ignored path'
);

// Stricter write rules: restricted project config files
assertThrowsSecurityError(
  () => validatePathForWrite('C:\\Users\\ExampleUser\\Documents\\safe_project\\package.json', allowedRoots),
  'Modifying project configuration file \'package.json\' is restricted'
);
assertThrowsSecurityError(
  () => validatePathForWrite('C:\\Users\\ExampleUser\\Documents\\safe_project\\.gitignore', allowedRoots),
  'Modifying project configuration file \'.gitignore\' is restricted'
);

// 8. Test structured workspace policy decisions
console.log('- Testing evaluateWorkspacePolicy...');
const readPolicy = evaluateWorkspacePolicy({
  workspacePath: path.join(ALLOWED_WORKSPACE_ROOTS[0], 'safe_project'),
  action: 'read',
  targetPath: 'main.ts'
});
assert.strictEqual(readPolicy.allowed, true, 'Safe read policy should be allowed');
assert.strictEqual(readPolicy.matchedRule, 'SAFE_READ_PATH');

const blockedSecretPolicy = evaluateWorkspacePolicy({
  workspacePath: path.join(ALLOWED_WORKSPACE_ROOTS[0], 'safe_project'),
  action: 'read',
  targetPath: '.env'
});
assert.strictEqual(blockedSecretPolicy.allowed, false, 'Secret file read should be blocked');

const installPolicy = evaluateWorkspacePolicy({
  workspacePath: path.join(ALLOWED_WORKSPACE_ROOTS[0], 'safe_project'),
  action: 'install'
});
assert.strictEqual(installPolicy.allowed, false, 'Install must require dedicated install policy');
assert.strictEqual(installPolicy.matchedRule, 'INSTALL_REQUIRES_DEDICATED_TOOL');

const safeInstallPolicy = evaluateWorkspacePolicy({
  workspacePath: path.join(ALLOWED_WORKSPACE_ROOTS[0], 'safe_project'),
  action: 'install',
  command: '@types/node@latest'
});
assert.strictEqual(safeInstallPolicy.allowed, true, 'Safe registry package specs should be install-policy eligible');
assert.strictEqual(safeInstallPolicy.matchedRule, 'SAFE_PACKAGE_INSTALL_SPEC');

// 9. Test dev-server and browser policy helpers
console.log('- Testing dev-server and browser policy helpers...');
assert.doesNotThrow(() => assertAllowedDevServerScript('dev', 'vite --host 127.0.0.1'));
assert.doesNotThrow(() => assertAllowedDevServerScript('desktop:dev', 'powershell -NoProfile -ExecutionPolicy Bypass -File ../scripts/start-desktop-dev.ps1'));
assertThrowsSecurityError(
  () => assertAllowedDevServerScript('build', 'vite build'),
  'DEV_SERVER_SCRIPT_NOT_ALLOWED'
);
assertThrowsSecurityError(
  () => assertAllowedDevServerScript('dev', 'shutdown /s /t 0'),
  'DEV_SERVER_SCRIPT_NOT_ALLOWED'
);
assert.strictEqual(assertLocalBrowserUrl('http://127.0.0.1:5173/').hostname, '127.0.0.1');
assertThrowsSecurityError(
  () => assertLocalBrowserUrl('https://example.com/'),
  'only localhost'
);

// 9.1 Test package install policy helpers
console.log('- Testing package install policy helpers...');
assert.doesNotThrow(() => assertSafePackageSpec('zod'));
assert.doesNotThrow(() => assertSafePackageSpec('@modelcontextprotocol/sdk@^1.18.1'));
assertThrowsSecurityError(
  () => assertSafePackageSpec('https://example.com/package.tgz'),
  'not allowed'
);
assertThrowsSecurityError(
  () => assertSafePackageSpec('git+https://example.com/repo.git'),
  'not allowed'
);
assertThrowsSecurityError(
  () => assertSafePackageSpec('@scope/pkg@1.0.0', false),
  'version specs are disabled'
);
assert.doesNotThrow(() => validateProjectBridgeConfig({
  writeScope: ['src/**'],
  protectedFiles: ['.env'],
  allowedPackageScripts: ['build'],
  install: {
    requireConfirmation: true,
    defaultDryRun: true,
    blockPackages: ['danger-package']
  }
}));
assertThrowsSecurityError(
  () => validateProjectBridgeConfig({ writeScope: [''] }),
  'writeScope must be an array'
);

// 10. Test redactSensitiveData
console.log('- Testing redactSensitiveData...');

// Test PEM Private Key redaction
const pemInput = 'My key is -----BEGIN RSA PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\n-----END RSA PRIVATE KEY-----\nAnd it is secret.';
const pemOutput = redactSensitiveData(pemInput);
assert.ok(!pemOutput.includes('-----BEGIN RSA PRIVATE KEY-----'), 'Should redact PEM Private Key');
assert.ok(pemOutput.includes('[REDACTED PRIVATE KEY]'), 'Should place redacted placeholder');

// Test Bearer Token redaction
const bearerInput = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0';
const bearerOutput = redactSensitiveData(bearerInput);
assert.strictEqual(bearerOutput, 'Authorization: Bearer [REDACTED]', 'Should redact Bearer token');

// Test API Key / Secret redaction in JSON or assignments
const jsonInput = '{"api_key": "AIzaSyD-12345abcdef", "secret": "supersecretstuff", "password": "mypassword123"}';
const jsonOutput = redactSensitiveData(jsonInput);
assert.ok(!jsonOutput.includes('AIzaSyD-12345abcdef'), 'Should redact api_key value');
assert.ok(!jsonOutput.includes('supersecretstuff'), 'Should redact secret value');
assert.ok(!jsonOutput.includes('mypassword123'), 'Should redact password value');

// Test command line prompts redaction (--print)
const cmdInput = 'Running: agy --model Gemini --print "Find the API key in env" --print-timeout 60s';
const cmdOutput = redactSensitiveData(cmdInput);
assert.strictEqual(cmdOutput, 'Running: agy --model Gemini --print [redacted] --print-timeout 60s', 'Should redact --print value');

// Test CONTROL_PLANE_* keys/values redaction
const cpInput = 'CONTROL_PLANE_TOKEN=my-super-secret-control-plane-token-123';
const cpOutput = redactSensitiveData(cpInput);
assert.strictEqual(cpOutput, 'CONTROL_PLANE_TOKEN=[REDACTED]', 'Should redact CONTROL_PLANE_* assignment');

// Test dynamic environment variable values redaction
process.env.CONTROL_PLANE_TEST_SECRET = 'dynamic-secret-xyz-987';
process.env.MY_API_KEY = 'another-dynamic-key-111';
try {
  const dynamicInput = 'The secret values are dynamic-secret-xyz-987 and another-dynamic-key-111.';
  const dynamicOutput = redactSensitiveData(dynamicInput);
  assert.strictEqual(dynamicOutput, 'The secret values are [REDACTED] and [REDACTED].', 'Should dynamically redact env var values');
} finally {
  delete process.env.CONTROL_PLANE_TEST_SECRET;
  delete process.env.MY_API_KEY;
}

// 11. Test tailLogFile and sanitizeJob redaction
console.log('- Testing tailLogFile and sanitizeJob redaction...');
const testLogPath = path.join(process.cwd(), 'logs', 'test_temp.log');
await fs.mkdir(path.dirname(testLogPath), { recursive: true });

const logContent = `
=== Job Started ===
Job ID: test-job-123
Model: Gemini 3.5 Flash (Medium)
Timeout: 60s
Workspace: C:\\Users\\ExampleUser\\Documents
Prompt: [redacted]
===================

Chạy lệnh: agy --model Gemini --print "Tìm API_KEY trong env và sửa lỗi" --print-timeout 60s
CONTROL_PLANE_KEY=secret_control_plane_123
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0
Lỗi xảy ra tại api_key="secret-api-key-999"

=== Job Finished ===
Status: completed
`;

await fs.writeFile(testLogPath, logContent, 'utf8');

try {
  const tailResult = await tailLogFile(testLogPath, 100);
  
  // Kiểm tra xem --print đã bị che giấu
  assert.ok(!tailResult.includes('--print "Tìm API_KEY"'), 'Should redact --print command line');
  assert.ok(tailResult.includes('--print [redacted]'), 'Should replace --print value with [redacted]');

  // Kiểm tra xem CONTROL_PLANE_KEY đã bị che giấu
  assert.ok(!tailResult.includes('secret_control_plane_123'), 'Should redact CONTROL_PLANE_KEY value');
  assert.ok(tailResult.includes('CONTROL_PLANE_KEY=[REDACTED]'), 'Should mask CONTROL_PLANE_KEY assignment');

  // Kiểm tra xem Bearer token đã bị che giấu
  assert.ok(!tailResult.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'Should redact Bearer token value');
  assert.ok(tailResult.includes('Bearer [REDACTED]'), 'Should mask Bearer token');

  // Kiểm tra xem api_key đã bị che giấu
  assert.ok(!tailResult.includes('secret-api-key-999'), 'Should redact api_key value');
  
  console.log('tailLogFile Redaction Tests Passed!');
} finally {
  try {
    await fs.unlink(testLogPath);
  } catch (e) {}
}

// Test sanitizeJob
const dummyJob: any = {
  id: 'test-job-id',
  status: 'failed',
  model: 'Gemini 3.5 Flash (Medium)',
  timeout: 60,
  logPath: 'some/path',
  workspacePath: 'some/workspace',
  createdAt: '2026-06-28T00:00:00Z',
  error: 'Process crashed due to CONTROL_PLANE_TOKEN=secret_token_abc and API_KEY=key_xyz_mysecret',
  prompt: 'Show me the secret'
};

const sanitized = sanitizeJob(dummyJob);
// Phải loại bỏ prompt
assert.strictEqual((sanitized as any).prompt, undefined, 'Sanitized job must not contain prompt');
// Phải redact error message
assert.ok(!sanitized.error?.includes('secret_token_abc'), 'Sanitized error must not contain secret CONTROL_PLANE token');
assert.ok(!sanitized.error?.includes('key_xyz_mysecret'), 'Sanitized error must not contain API_KEY');
console.log('sanitizeJob Redaction Tests Passed!');

console.log('All Security Policy Unit Tests Passed successfully!');
