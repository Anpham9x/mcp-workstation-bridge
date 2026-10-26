import type { IncomingHttpHeaders } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const DEFAULT_REQUIRED_SCOPES = ['mcp:access', 'powershell:execute'];
const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export interface NextOAuthConfig {
  resource: string;
  issuer: string;
  audience: string;
  requiredScopes: string[];
}

export interface AuthenticatedPrincipal {
  subject: string;
  scopes: string[];
  claims: JWTPayload;
}

function normalizeIssuer(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function requireHttpsUrl(value: string, name: string): string {
  const parsed = new URL(value);
  const testHttpAllowed = process.env.NODE_ENV === 'test' && parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !testHttpAllowed) {
    throw new Error(`${name} must use HTTPS.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

export function isNextPluginEnabled(): boolean {
  return process.env.MCP_NEXT_ENABLED === '1';
}

export function getNextOAuthConfig(): NextOAuthConfig {
  const resourceValue = process.env.MCP_NEXT_RESOURCE_URL?.trim();
  const issuerValue = process.env.MCP_NEXT_OAUTH_ISSUER?.trim();
  const audience = process.env.MCP_NEXT_OAUTH_AUDIENCE?.trim();

  if (!resourceValue || !issuerValue || !audience) {
    throw new Error('MCP Next requires MCP_NEXT_RESOURCE_URL, MCP_NEXT_OAUTH_ISSUER, and MCP_NEXT_OAUTH_AUDIENCE.');
  }

  const requiredScopes = (process.env.MCP_NEXT_REQUIRED_SCOPES || DEFAULT_REQUIRED_SCOPES.join(' '))
    .split(/\s+/)
    .filter(Boolean);
  if (requiredScopes.length === 0) {
    throw new Error('MCP_NEXT_REQUIRED_SCOPES must contain at least one scope.');
  }

  return {
    resource: requireHttpsUrl(resourceValue, 'MCP_NEXT_RESOURCE_URL'),
    issuer: `${requireHttpsUrl(normalizeIssuer(issuerValue), 'MCP_NEXT_OAUTH_ISSUER')}/`,
    audience,
    requiredScopes
  };
}

export function assertNextOAuthConfiguration(): void {
  if (!isNextPluginEnabled()) return;
  getNextOAuthConfig();
  if (process.env.MCP_POWERSHELL_ENABLED !== '1') {
    throw new Error('MCP_NEXT_ENABLED=1 requires MCP_POWERSHELL_ENABLED=1.');
  }
}

export function getProtectedResourceMetadataPath(config = getNextOAuthConfig()): string {
  const url = new URL(config.resource);
  const suffix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `/.well-known/oauth-protected-resource${suffix}`;
}

export function getProtectedResourceMetadata(config = getNextOAuthConfig()): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer.replace(/\/$/, '')],
    scopes_supported: config.requiredScopes,
    resource_documentation: `${new URL(config.resource).origin}/mcp-next/docs`
  };
}

export function getOAuthChallenge(config = getNextOAuthConfig(), error = 'invalid_token'): string {
  const metadataUrl = `${new URL(config.resource).origin}${getProtectedResourceMetadataPath(config)}`;
  return `Bearer resource_metadata="${metadataUrl}", scope="${config.requiredScopes.join(' ')}", error="${error}"`;
}

function getBearerToken(headers: IncomingHttpHeaders): string | undefined {
  const raw = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  if (!raw?.startsWith('Bearer ')) return undefined;
  return raw.slice('Bearer '.length).trim() || undefined;
}

function getJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const jwksUrl = new URL('.well-known/jwks.json', issuer).toString();
  let jwks = remoteJwks.get(jwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl));
    remoteJwks.set(jwksUrl, jwks);
  }
  return jwks;
}

export async function authenticateNextRequest(
  headers: IncomingHttpHeaders,
  config = getNextOAuthConfig()
): Promise<AuthenticatedPrincipal> {
  const token = getBearerToken(headers);
  if (!token) throw new Error('Missing OAuth access token.');

  const { payload } = await jwtVerify(token, getJwks(config.issuer), {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ['RS256']
  });
  if (!payload.sub) throw new Error('OAuth access token is missing sub.');

  const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [];
  const missingScopes = config.requiredScopes.filter(scope => !scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new Error(`OAuth access token is missing scopes: ${missingScopes.join(', ')}.`);
  }

  return { subject: payload.sub, scopes, claims: payload };
}
