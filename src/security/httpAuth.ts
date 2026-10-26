import { timingSafeEqual } from 'node:crypto';

const MIN_BEARER_TOKEN_LENGTH = 32;

export function isPowerShellEnabled(): boolean {
  return process.env.MCP_POWERSHELL_ENABLED === '1';
}

export function getConfiguredBearerToken(): string | undefined {
  const token = process.env.MCP_BRIDGE_BEARER_TOKEN?.trim();
  return token || undefined;
}

export function isBearerAuthenticationRequired(): boolean {
  return process.env.MCP_BRIDGE_REQUIRE_BEARER === '1';
}

export function assertSecureRuntimeConfiguration(): void {
  const token = getConfiguredBearerToken();

  if (isBearerAuthenticationRequired() && token && token.length < MIN_BEARER_TOKEN_LENGTH) {
    throw new Error(`MCP_BRIDGE_BEARER_TOKEN must contain at least ${MIN_BEARER_TOKEN_LENGTH} characters.`);
  }

  if (isBearerAuthenticationRequired() && !token) {
    throw new Error('MCP_BRIDGE_REQUIRE_BEARER=1 requires MCP_BRIDGE_BEARER_TOKEN. The server was not started.');
  }
}

export function hasVerifiedBearer(authorizationHeader: string | string[] | undefined): boolean {

  const configuredToken = getConfiguredBearerToken();
  if (!configuredToken || configuredToken.length < MIN_BEARER_TOKEN_LENGTH) return false;

  const header = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (!header?.startsWith('Bearer ')) {
    return false;
  }

  const suppliedToken = header.slice('Bearer '.length).trim();
  const expected = Buffer.from(configuredToken, 'utf8');
  const supplied = Buffer.from(suppliedToken, 'utf8');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function isAuthorizedRequest(authorizationHeader: string | string[] | undefined): boolean {
  return !isBearerAuthenticationRequired() || hasVerifiedBearer(authorizationHeader);
}
