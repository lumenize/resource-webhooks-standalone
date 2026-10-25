// The client half of authorization against a fake authorization server, since A's own never
// misbehaves in the ways these refusals guard against. Below the public API by design: the
// fake stands in for the servers a client must not trust.
import { describe, expect, it } from 'vitest';
import { createMcpClient, HttpError, OAuthError, OAuthSession } from '../../src/client/mcp-client';

const RS = 'https://rs.example';
const REDIRECT = 'http://localhost:3000/callback';

interface FakeOptions {
  issuer?: string;
  metadata?: Record<string, unknown>;
  /** How many authorization requests answer invalid_client before one succeeds. */
  forgetClients?: number;
  /** Overrides the authorization redirect's query. */
  redirectWith?: (state: string) => Record<string, string>;
}

function fakeServers({ issuer = 'https://as.example', metadata = {}, forgetClients = 0, redirectWith }: FakeOptions = {}) {
  const calls: { url: string; body?: string; redirect?: string }[] = [];
  let registrations = 0;
  let forgotten = 0;
  const send = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? init.body : undefined;
    calls.push({ url, body, redirect: init.redirect });
    const { pathname, searchParams } = new URL(url);
    if (url === `${RS}/.well-known/oauth-protected-resource/mcp`) return Response.json({ resource: `${RS}/mcp`, authorization_servers: [issuer] });
    if (url === `${issuer}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        authorization_response_iss_parameter_supported: true,
        ...metadata,
      });
    }
    if (url === `${issuer}/register`) return Response.json({ client_id: `client-${++registrations}`, client_secret: `secret-${registrations}` }, { status: 201 });
    if (url.startsWith(`${issuer}/authorize`)) {
      if (forgotten < forgetClients) {
        forgotten++;
        return Response.json({ error: 'invalid_client' }, { status: 400 });
      }
      const query = redirectWith?.(searchParams.get('state')!) ?? { code: 'the-code', state: searchParams.get('state')!, iss: issuer };
      return new Response(null, { status: 302, headers: { Location: `${REDIRECT}?${new URLSearchParams(query)}` } });
    }
    if (url === `${issuer}/token`) return Response.json({ access_token: `token-for-${new URLSearchParams(body).get('client_id')}` });
    if (pathname === '/mcp') return new Response('Unauthorized', { status: 401 });
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
  return { send, calls, registrations: () => registrations };
}

describe('the client half of authorization', () => {
  it('refuses an authorization server that does not say it offers PKCE with S256', async () => {
    const { send } = fakeServers({ metadata: { code_challenge_methods_supported: ['plain'] } });
    const session = new OAuthSession({ redirectUri: REDIRECT, fetch: send });
    await expect(session.tokenFor(`${RS}/mcp`)).rejects.toThrow('does not say it offers PKCE with S256');
    const { send: silent } = fakeServers({ metadata: { code_challenge_methods_supported: undefined } });
    await expect(new OAuthSession({ redirectUri: REDIRECT, fetch: silent }).tokenFor(`${RS}/mcp`)).rejects.toThrow(OAuthError);
  });

  it('never sends credentials registered with one authorization server to another', async () => {
    const { send, calls } = fakeServers({ issuer: 'https://as2.example' });
    const session = new OAuthSession({
      redirectUri: REDIRECT,
      client: { issuer: 'https://as1.example', clientId: 'pre-registered', clientSecret: 'pre-registered-secret' },
      fetch: send,
    });
    expect(await session.tokenFor(`${RS}/mcp`)).toBe('token-for-client-1');
    expect(calls.some(({ body }) => body?.includes('pre-registered-secret'))).toBe(false);
  });

  it('registers again, once, when the server has forgotten its client', async () => {
    const { send, registrations } = fakeServers({ forgetClients: 1 });
    const session = new OAuthSession({ redirectUri: REDIRECT, fetch: send });
    expect(await session.tokenFor(`${RS}/mcp`)).toBe('token-for-client-2');
    expect(registrations()).toBe(2);
    const { send: amnesiac } = fakeServers({ forgetClients: 5 });
    await expect(new OAuthSession({ redirectUri: REDIRECT, fetch: amnesiac }).tokenFor(`${RS}/mcp`)).rejects.toThrow('invalid_client');
  });

  it('checks the issuer of an authorization response before acting on an error in it', async () => {
    const { send } = fakeServers({ redirectWith: (state) => ({ error: 'access_denied', state, iss: 'https://impostor.example' }) });
    await expect(new OAuthSession({ redirectUri: REDIRECT, fetch: send }).tokenFor(`${RS}/mcp`)).rejects.toThrow('names another issuer');
  });

  it('follows no redirect from the MCP endpoint, so a token never travels on to its target', async () => {
    const seen: (string | undefined)[] = [];
    const send = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push(init.redirect);
      return new Response(null, { status: 307, headers: { Location: 'https://elsewhere.example/mcp' } });
    }) as typeof fetch;
    const client = createMcpClient({ endpoint: `${RS}/mcp`, fetch: send });
    await expect(client.request('tools/list')).rejects.toThrow(HttpError);
    expect(seen).toEqual(['manual']);
  });
});
