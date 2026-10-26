import assert from 'node:assert/strict';
import {
  assertNextOAuthConfiguration,
  getNextOAuthConfig,
  getOAuthChallenge,
  getProtectedResourceMetadata,
  getProtectedResourceMetadataPath
} from './oauth.js';

const originalEnv = { ...process.env };

try {
  process.env.NODE_ENV = 'test';
  process.env.MCP_NEXT_ENABLED = '1';
  process.env.MCP_POWERSHELL_ENABLED = '1';
  process.env.MCP_NEXT_RESOURCE_URL = 'http://127.0.0.1:43001/mcp-next';
  process.env.MCP_NEXT_OAUTH_ISSUER = 'http://127.0.0.1:43002';
  process.env.MCP_NEXT_OAUTH_AUDIENCE = 'mcp-next-test';
  process.env.MCP_NEXT_REQUIRED_SCOPES = 'mcp:access powershell:execute';

  assert.doesNotThrow(() => assertNextOAuthConfiguration());
  const config = getNextOAuthConfig();
  assert.equal(config.issuer, 'http://127.0.0.1:43002/');
  assert.equal(getProtectedResourceMetadataPath(config), '/.well-known/oauth-protected-resource/mcp-next');
  assert.deepEqual(getProtectedResourceMetadata(config), {
    resource: 'http://127.0.0.1:43001/mcp-next',
    authorization_servers: ['http://127.0.0.1:43002'],
    scopes_supported: ['mcp:access', 'powershell:execute'],
    resource_documentation: 'http://127.0.0.1:43001/mcp-next/docs'
  });
  assert.match(getOAuthChallenge(config), /resource_metadata="http:\/\/127\.0\.0\.1:43001\/\.well-known\/oauth-protected-resource\/mcp-next"/);

  process.env.MCP_POWERSHELL_ENABLED = '0';
  assert.throws(() => assertNextOAuthConfiguration(), /requires MCP_POWERSHELL_ENABLED=1/);

  process.env.NODE_ENV = 'production';
  process.env.MCP_POWERSHELL_ENABLED = '1';
  assert.throws(() => getNextOAuthConfig(), /must use HTTPS/);

  console.log('PASS: OAuth configuration and protected-resource metadata tests passed.');
} finally {
  process.env = originalEnv;
}
