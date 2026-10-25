import { listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationServer } from '../../src/auth/authorization-server';
import { base64url, sha256, signToken, type TokenClaims } from '../../src/auth/signing';
import { callWorker, newLane, type Lane } from './lane';

const ENVELOPE = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const REDIRECT = `${env.ORIGIN}/callback`;

async function serverIds(): Promise<string[]> {
  return (await listDurableObjectIds(env.SERVER)).map((id) => id.toString());
}

function call(lane: Lane, path: string, init: RequestInit = {}): Promise<Response> {
  return callWorker(new Request(`${env.ORIGIN}${path}`, init), lane.env);
}

function toolsList(lane: Lane, token?: string, extra: Record<string, string> = {}): Promise<Response> {
  return call(lane, `/server/${lane.name}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/list',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } }),
  });
}

function claimsFor(lane: Lane, overrides: Partial<TokenClaims> = {}): TokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return { iss: env.ORIGIN, sub: 'someone', aud: `${lane.root}/mcp`, iat: now, exp: now + 3600, epoch: 0, ...overrides };
}

// The steps of the code flow by hand, so a test can change any one of them.
async function register(lane: Lane, redirectUri = REDIRECT): Promise<{ clientId: string; clientSecret: string; response: Response }> {
  const response = await call(lane, '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirectUri] }) });
  const body = response.ok ? ((await response.clone().json()) as { client_id: string; client_secret: string }) : { client_id: '', client_secret: '' };
  return { clientId: body.client_id, clientSecret: body.client_secret, response };
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function authorize(lane: Lane, params: Record<string, string>): Promise<Response> {
  return call(lane, `/authorize?${new URLSearchParams(params)}`);
}

async function codeFor(lane: Lane, clientId: string, challenge: string, resource = `${lane.root}/mcp`): Promise<string> {
  const response = await authorize(lane, {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 's',
    resource,
  });
  expect(response.status).toBe(302);
  return new URL(response.headers.get('Location')!).searchParams.get('code')!;
}

function redeem(lane: Lane, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return call(lane, '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ grant_type: 'authorization_code', redirect_uri: REDIRECT, ...form }).toString(),
  });
}

async function errorOf(response: Response): Promise<{ status: number; error: string }> {
  return { status: response.status, error: ((await response.json()) as { error: string }).error };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('tokens at the edge', () => {
  it("answers a call without a token with 401 naming A's resource metadata, and wakes no object", async () => {
    const lane = newLane();
    const before = await serverIds();
    const response = await toolsList(lane);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${env.ORIGIN}/.well-known/oauth-protected-resource/server/${lane.name}/mcp"`,
    );
    expect(await serverIds()).toEqual(before);
  });

  it('refuses a token with a bad signature, an expired one and one naming another alg, waking no object', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const lane = newLane();
    const good = await signToken(env.TOKEN_SIGNING_KEY, claimsFor(lane));
    const forged = await signToken('another-key', claimsFor(lane));
    const expiring = await signToken(env.TOKEN_SIGNING_KEY, claimsFor(lane, { exp: Math.floor(Date.now() / 1000) + 60 }));
    const [, payload, signature] = good.split('.');
    const otherAlg = `${base64url(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })))}.${payload}.${signature}`;
    vi.setSystemTime(Date.now() + 120_000);
    const before = await serverIds();

    for (const [label, token, reason] of [
      ['forged', forged, 'The token signature does not verify'],
      ['expired', expiring, 'The token has expired'],
      ['another alg', otherAlg, 'The token names an algorithm other than HS256'],
    ]) {
      const response = await toolsList(lane, token);
      expect({ label, status: response.status, body: await response.json() }).toEqual({
        label,
        status: 401,
        body: { error: 'invalid_token', error_description: reason },
      });
    }
    expect(await serverIds()).toEqual(before);
  });

  it("refuses b's token for its socket on B, whose audience is not A", async () => {
    const lane = newLane();
    await lane.token();
    const clientId = lane.session.clientIdFor(env.ORIGIN)!;
    const socketToken = await lane.session.tokenForResource(env.ORIGIN, `${env.ORIGIN}/gateway/B/ws/${clientId}`);
    const response = await toolsList(lane, socketToken);
    expect(await errorOf(response)).toEqual({ status: 401, error: 'invalid_token' });
    expect(response.headers.get('WWW-Authenticate')).toContain('The token is for another resource');
    expect((await toolsList(lane, await lane.token())).status).toBe(200);
  });

  it('treats a request that sets the claims header itself, with no token, as anonymous', async () => {
    const lane = newLane();
    const spoofed = { 'x-rw-principal': JSON.stringify({ sub: 'someone', epoch: 0 }) };
    expect((await toolsList(lane, undefined, spoofed)).status).toBe(401);
    expect((await lane.fetch('/notes/inbox/note-1', { method: 'PUT', headers: { ...spoofed, Authorization: 'Bearer nonsense' }, body: '{"title":"x"}' })).status).toBe(401);
  });

  it('refuses a token issued in an earlier epoch, which only A can tell', async () => {
    const lane = newLane();
    const earlier = await signToken(env.TOKEN_SIGNING_KEY, claimsFor(lane, { epoch: 0 }));
    expect((await toolsList(lane, earlier)).status).toBe(200);
    // Below the public API: phase 4's Wipe raises the epoch, and until then only a write by hand can.
    await runInDurableObject(lane.stub, (_instance, state) => {
      state.storage.sql.exec('INSERT OR REPLACE INTO Epoch (id, value) VALUES (1, 1)');
    });
    const response = await toolsList(lane, earlier);
    expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'The token was issued before the last Wipe' });
    expect(response.status).toBe(401);
  });

  it('lets a GET of a note through with no token, and refuses a PUT or DELETE without one', async () => {
    const lane = newLane();
    await lane.fetch('/notes/inbox/note-1', { method: 'PUT', body: '{"title":"Open"}' });
    expect((await call(lane, `/server/${lane.name}/notes/inbox/note-1`)).status).toBe(200);
    for (const method of ['PUT', 'DELETE']) {
      const response = await call(lane, `/server/${lane.name}/notes/inbox/note-1`, { method, body: method === 'PUT' ? '{"title":"Shut"}' : undefined });
      expect({ method, status: response.status }).toEqual({ method, status: 401 });
    }
    expect(await (await call(lane, `/server/${lane.name}/notes/inbox/note-1`)).text()).toBe('{"title":"Open"}');
  });
});

describe('the authorization server', () => {
  it('serves its metadata and A\'s without waking A', async () => {
    const lane = newLane();
    const before = await serverIds();
    const resource = await call(lane, `/.well-known/oauth-protected-resource/server/${lane.name}/mcp`);
    expect(await resource.json()).toEqual({ resource: `${lane.root}/mcp`, authorization_servers: [env.ORIGIN], bearer_methods_supported: ['header'] });
    const server = await call(lane, '/.well-known/oauth-authorization-server');
    expect(await server.json()).toMatchObject({ issuer: env.ORIGIN, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] });
    expect(await serverIds()).toEqual(before);
  });

  it('refuses a code redeemed without its client\'s secret, or with another client\'s', async () => {
    const lane = newLane();
    const first = await register(lane);
    const second = await register(lane);
    const { verifier, challenge } = await pkce();
    const code = await codeFor(lane, first.clientId, challenge);
    const base = { code, code_verifier: verifier, resource: `${lane.root}/mcp` };

    expect(await errorOf(await redeem(lane, { ...base, client_id: first.clientId }))).toEqual({ status: 400, error: 'invalid_client' });
    expect(await errorOf(await redeem(lane, { ...base, client_id: first.clientId, client_secret: second.clientSecret }))).toEqual({ status: 400, error: 'invalid_client' });
    // Another client's own credentials verify, but the code was not issued to it.
    expect(await errorOf(await redeem(lane, { ...base, client_id: second.clientId, client_secret: second.clientSecret }))).toEqual({ status: 400, error: 'invalid_grant' });
    expect((await redeem(lane, { ...base, client_id: first.clientId, client_secret: first.clientSecret })).status).toBe(200);
  });

  it('refuses a missing or plain code challenge, and a wrong verifier', async () => {
    const lane = newLane();
    const { clientId, clientSecret } = await register(lane);
    const base = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's', resource: `${lane.root}/mcp` };
    for (const challenge of [{}, { code_challenge: 'abc', code_challenge_method: 'plain' }, { code_challenge: 'abc' }]) {
      const response = await authorize(lane, { ...base, ...(challenge as Record<string, string>) });
      const back = new URL(response.headers.get('Location')!).searchParams;
      // RFC 9207 puts the issuer on an error response too.
      expect({ challenge, error: back.get('error'), iss: back.get('iss') }).toEqual({ challenge, error: 'invalid_request', iss: env.ORIGIN });
    }
    const { challenge } = await pkce();
    const code = await codeFor(lane, clientId, challenge);
    const wrong = await redeem(lane, { code, code_verifier: 'not-the-verifier', client_id: clientId, client_secret: clientSecret });
    expect(await errorOf(wrong)).toEqual({ status: 400, error: 'invalid_grant' });
  });

  it('honours a code once, and only with the client, redirect URI and resource it was issued for', async () => {
    const lane = newLane();
    const { clientId, clientSecret } = await register(lane);
    const { verifier, challenge } = await pkce();
    const code = await codeFor(lane, clientId, challenge);
    const base = { code, code_verifier: verifier, client_id: clientId, client_secret: clientSecret };

    expect(await errorOf(await redeem(lane, { ...base, redirect_uri: `${env.ORIGIN}/elsewhere` }))).toEqual({ status: 400, error: 'invalid_grant' });
    expect(await errorOf(await redeem(lane, { ...base, resource: `${env.ORIGIN}/gateway/B/ws/${clientId}` }))).toEqual({ status: 400, error: 'invalid_target' });
    const first = await redeem(lane, base);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(await errorOf(await redeem(lane, base))).toEqual({ status: 400, error: 'invalid_grant' });
  });

  it('registers a redirect URI only on its own origin or loopback, and authorizes only the exact one', async () => {
    const lane = newLane();
    for (const uri of ['https://evil.example/callback', 'http://localhost.evil.example/callback', `${env.ORIGIN.replace('https', 'http')}/callback`]) {
      expect({ uri, ...(await errorOf((await register(lane, uri)).response)) }).toEqual({ uri, status: 400, error: 'invalid_redirect_uri' });
    }
    expect((await register(lane, 'http://127.0.0.1:3000/callback')).response.status).toBe(201);
    const { clientId } = await register(lane);
    const { challenge } = await pkce();
    const response = await authorize(lane, {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: `${REDIRECT}/more`,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${lane.root}/mcp`,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
  });

  it("issues a token only for A's MCP endpoint or the client's own socket on B", async () => {
    const lane = newLane();
    const { clientId } = await register(lane);
    const other = await register(lane);
    const { challenge } = await pkce();
    for (const resource of [`${env.ORIGIN}/gateway/B/ws/${other.clientId}`, `${env.ORIGIN}/gateway/B/ws/c`, `${env.ORIGIN}/server/X/mcp`]) {
      const response = await authorize(lane, {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource,
      });
      expect({ resource, error: new URL(response.headers.get('Location')!).searchParams.get('error') }).toEqual({ resource, error: 'invalid_target' });
    }
    expect((await codeFor(lane, clientId, challenge, `${env.ORIGIN}/gateway/B/ws/${clientId}`)).length).toBeGreaterThan(0);
  });

  it('never redirects for a client id whose signature does not verify, however it is shaped', async () => {
    const lane = newLane();
    const evil = 'https://evil.example/callback';
    const { clientId } = await register(lane);
    const [epoch, , nonce, signature] = clientId.split('.');
    const forged = `${epoch}.${(await sha256(evil)).slice(0, 22)}.${nonce}.${signature}`;
    const { challenge } = await pkce();
    const response = await authorize(lane, {
      response_type: 'code',
      client_id: forged,
      redirect_uri: evil,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${lane.root}/mcp`,
    });
    expect(await errorOf(response.clone())).toEqual({ status: 400, error: 'invalid_client' });
    expect(response.headers.get('Location')).toBeNull();
  });

  it('refuses a code redeemed after its minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const lane = newLane();
    const { clientId, clientSecret } = await register(lane);
    const { verifier, challenge } = await pkce();
    const code = await codeFor(lane, clientId, challenge);
    vi.setSystemTime(Date.now() + 61_000);
    const late = await redeem(lane, { code, code_verifier: verifier, client_id: clientId, client_secret: clientSecret });
    expect(await errorOf(late)).toEqual({ status: 400, error: 'invalid_grant' });
  });

  it('refuses a registration that is not a JSON object, or whose redirect URI has a fragment or is no URL', async () => {
    const lane = newLane();
    const post = (body: string) => call(lane, '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(await errorOf(await post('null'))).toEqual({ status: 400, error: 'invalid_client_metadata' });
    for (const uri of [`${REDIRECT}#here`, 'http://localhost:99999/callback']) {
      expect({ uri, ...(await errorOf((await register(lane, uri)).response)) }).toEqual({ uri, status: 400, error: 'invalid_redirect_uri' });
    }
  });

  it('refuses a body over 16 KiB on its routes before A wakes', async () => {
    const lane = newLane();
    const before = await serverIds();
    const response = await call(lane, '/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT], pad: 'x'.repeat(17 * 1024) }) });
    expect(response.status).toBe(413);
    expect(await serverIds()).toEqual(before);
  });

  it('refuses a cross-origin POST to the token endpoint with 403', async () => {
    const lane = newLane();
    const response = await call(lane, '/token', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: 'grant_type=authorization_code' });
    expect(response.status).toBe(403);
  });

  it('refuses to start with a registration cap that is not a positive integer', async () => {
    const lane = newLane();
    // Below the public API: the cap comes from a binding, so only a server built by hand can be
    // given a bad one.
    const names = await runInDurableObject(lane.stub, (_instance, state) =>
      [NaN, 0, 1.5].map((registrationCap) => {
        try {
          new AuthorizationServer({ sql: state.storage.sql, secret: 's', origin: env.ORIGIN, epoch: () => 0, resourcesFor: () => [], registrationCap });
          return 'started';
        } catch (error) {
          return (error as Error).name;
        }
      }),
    );
    expect(names).toEqual(['RangeError', 'RangeError', 'RangeError']);
  });

  it('answers 429 past the registration cap', async () => {
    const lane = newLane();
    for (let i = 0; i < Number(env.REGISTRATION_CAP); i++) expect((await register(lane)).response.status).toBe(201);
    expect(await errorOf((await register(lane)).response)).toEqual({ status: 429, error: 'temporarily_unavailable' });
  });
});
