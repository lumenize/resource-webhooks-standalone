// The prototype's OAuth 2.1 authorization server, scaffolding that verifies no identity: anyone
// may register and is approved at once, but each registration is a principal of its own. It
// keeps no registrations. A client id is a signed value carrying A's epoch and a hash of its one
// redirect URI, its secret derives from it, and a code is signed and short-lived. A writes only
// a count of registrations per epoch and the codes already redeemed.
import { base64url, fromBase64url, mac, randomToken, sha256, signToken, verifyMac, type TokenClaims } from './signing';

export interface AuthorizationServerOptions {
  sql: SqlStorage;
  secret: string;
  /** The Worker's origin, the issuer, as `https://….workers.dev`. */
  origin: string;
  /** A's epoch now, so a Wipe invalidates every client id and token issued before it. */
  epoch: () => number;
  /** The resources a client may get a token for, as A's MCP endpoint and its own socket on B. */
  resourcesFor: (clientId: string) => readonly string[];
  /** How many clients may register in one epoch. */
  registrationCap: number;
}

export const TOKEN_LIFETIME_SECONDS = 3600;
const CODE_LIFETIME_SECONDS = 60;
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//;

interface CodeClaims {
  cid: string;
  ru: string;
  res: string;
  cc: string;
  exp: number;
  jti: string;
}

export class AuthorizationServer {
  readonly #sql: SqlStorage;
  readonly #options: AuthorizationServerOptions;

  constructor(options: AuthorizationServerOptions) {
    // A cap that is not a positive integer would bound nothing, so A refuses to start without one.
    if (!Number.isInteger(options.registrationCap) || options.registrationCap < 1) {
      throw new RangeError(`The registration cap must be a positive integer, not ${options.registrationCap}`);
    }
    this.#sql = options.sql;
    this.#options = options;
    options.sql.exec(`
      CREATE TABLE IF NOT EXISTS Registrations (epoch INTEGER PRIMARY KEY, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS RedeemedCodes (id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL) WITHOUT ROWID;
    `);
  }

  /** RFC 7591 registration of a confidential client with one redirect URI. */
  async register(request: Request): Promise<Response> {
    let metadata: { redirect_uris?: unknown; token_endpoint_auth_method?: unknown; client_name?: unknown };
    try {
      metadata = (await request.json()) as typeof metadata;
    } catch {
      return oauthError(400, 'invalid_client_metadata', 'The body is not JSON');
    }
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return oauthError(400, 'invalid_client_metadata', 'The body is not a JSON object');
    }
    const uris = metadata.redirect_uris;
    if (!Array.isArray(uris) || uris.length !== 1 || typeof uris[0] !== 'string') {
      return oauthError(400, 'invalid_redirect_uri', 'Register exactly one redirect URI');
    }
    const redirectUri = uris[0];
    let parsed: URL;
    try {
      parsed = new URL(redirectUri);
    } catch {
      return oauthError(400, 'invalid_redirect_uri', 'The redirect URI is not a URL');
    }
    // RFC 6749 § 3.1.2: a redirect URI has no fragment.
    if (parsed.hash || redirectUri.includes('#')) return oauthError(400, 'invalid_redirect_uri', 'A redirect URI has no fragment');
    if (!redirectUri.startsWith(`${this.#options.origin}/`) && !LOOPBACK.test(redirectUri)) {
      return oauthError(400, 'invalid_redirect_uri', "A redirect URI must be on this server's origin or loopback");
    }
    const method = metadata.token_endpoint_auth_method ?? 'client_secret_post';
    if (method !== 'client_secret_post') {
      return oauthError(400, 'invalid_client_metadata', 'The only token endpoint auth method is client_secret_post');
    }
    const epoch = this.#options.epoch();
    const count = this.#sql.exec<{ count: number }>('SELECT count FROM Registrations WHERE epoch = ?', epoch).toArray()[0]?.count ?? 0;
    if (count >= this.#options.registrationCap) {
      return oauthError(429, 'temporarily_unavailable', 'Too many clients have registered since the last Wipe');
    }
    this.#sql.exec('INSERT INTO Registrations (epoch, count) VALUES (?, 1) ON CONFLICT (epoch) DO UPDATE SET count = count + 1', epoch);

    const unsigned = `${epoch}.${(await sha256(redirectUri)).slice(0, 22)}.${randomToken(12)}`;
    const clientId = `${unsigned}.${await mac(this.#options.secret, 'client-id', unsigned)}`;
    return Response.json(
      {
        client_id: clientId,
        client_secret: await this.#clientSecret(clientId),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        ...(typeof metadata.client_name === 'string' ? { client_name: metadata.client_name } : {}),
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  /** The authorization endpoint, which approves at once and redirects with a code. */
  async authorize(url: URL): Promise<Response> {
    const params = url.searchParams;
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    // Before the redirect URI is known good, an error is shown here and never redirected.
    if (!(await this.#validClientId(clientId))) return oauthError(400, 'invalid_client', 'Unknown client');
    if (!(await this.#redirectUriMatches(clientId, redirectUri))) {
      return oauthError(400, 'invalid_request', 'The redirect URI is not the one this client registered');
    }
    const back = new URL(redirectUri);
    const state = params.get('state');
    // RFC 9207: the issuer goes on every response, an error's included.
    const fail = (error: string, description: string) => redirect(back, { error, error_description: description, state, iss: this.#options.origin });
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only the code flow is supported');
    const challenge = params.get('code_challenge');
    if (!challenge || params.get('code_challenge_method') !== 'S256') {
      return fail('invalid_request', 'PKCE with code_challenge_method S256 is required');
    }
    const resource = params.get('resource') ?? '';
    if (!this.#options.resourcesFor(clientId).includes(resource)) {
      return fail('invalid_target', "The resource is neither A's MCP endpoint nor this client's own socket on B");
    }
    const claims: CodeClaims = {
      cid: clientId,
      ru: redirectUri,
      res: resource,
      cc: challenge,
      exp: Math.floor(Date.now() / 1000) + CODE_LIFETIME_SECONDS,
      jti: randomToken(12),
    };
    const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
    const code = `${payload}.${await mac(this.#options.secret, 'code', payload)}`;
    return redirect(back, { code, state, iss: this.#options.origin });
  }

  /** The token endpoint, for the authorization code grant with PKCE and `client_secret_post`. */
  async token(request: Request): Promise<Response> {
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await request.text());
    } catch {
      return oauthError(400, 'invalid_request', 'The body is not a form');
    }
    if (form.get('grant_type') !== 'authorization_code') {
      return oauthError(400, 'unsupported_grant_type', 'Only the authorization_code grant is supported');
    }
    const clientId = form.get('client_id') ?? '';
    const clientSecret = form.get('client_secret') ?? '';
    const secretValid = (await this.#validClientId(clientId)) && (await verifyMac(this.#options.secret, 'client-secret', clientId, clientSecret));
    // 400, which RFC 6749 § 5.2 allows for a client that authenticates in the body, as here.
    if (!secretValid) return oauthError(400, 'invalid_client', 'The client id and secret do not verify');

    const claims = await this.#codeClaims(form.get('code') ?? '');
    if (!claims) return oauthError(400, 'invalid_grant', 'The code is not one this server issued, or has expired');
    if (claims.cid !== clientId) return oauthError(400, 'invalid_grant', 'The code was issued to another client');
    if (claims.ru !== form.get('redirect_uri')) return oauthError(400, 'invalid_grant', 'The redirect URI differs from the authorization request');
    const resource = form.get('resource') ?? claims.res;
    if (resource !== claims.res) return oauthError(400, 'invalid_target', 'The resource differs from the authorization request');
    if ((await sha256(form.get('code_verifier') ?? '')) !== claims.cc) return oauthError(400, 'invalid_grant', 'The code verifier does not match');
    if (!this.#redeem(claims)) return oauthError(400, 'invalid_grant', 'The code has already been used');

    const now = Math.floor(Date.now() / 1000);
    const token: TokenClaims = {
      iss: this.#options.origin,
      sub: clientId,
      aud: resource,
      iat: now,
      exp: now + TOKEN_LIFETIME_SECONDS,
      epoch: this.#options.epoch(),
    };
    return Response.json(
      { access_token: await signToken(this.#options.secret, token), token_type: 'Bearer', expires_in: TOKEN_LIFETIME_SECONDS },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  /** Forgets the registration counts and redeemed codes, as a Wipe does. The epoch voids the rest. */
  clear(): void {
    this.#sql.exec('DELETE FROM Registrations');
    this.#sql.exec('DELETE FROM RedeemedCodes');
  }

  async #clientSecret(clientId: string): Promise<string> {
    return mac(this.#options.secret, 'client-secret', clientId);
  }

  async #validClientId(clientId: string): Promise<boolean> {
    const parts = clientId.split('.');
    if (parts.length !== 4 || Number(parts[0]) !== this.#options.epoch()) return false;
    return verifyMac(this.#options.secret, 'client-id', parts.slice(0, 3).join('.'), parts[3]);
  }

  async #redirectUriMatches(clientId: string, redirectUri: string): Promise<boolean> {
    return clientId.split('.')[1] === (await sha256(redirectUri)).slice(0, 22);
  }

  async #codeClaims(code: string): Promise<CodeClaims | undefined> {
    const [payload, signature, ...rest] = code.split('.');
    if (rest.length > 0 || !payload || !signature) return undefined;
    if (!(await verifyMac(this.#options.secret, 'code', payload, signature))) return undefined;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as CodeClaims;
    return claims.exp > Math.floor(Date.now() / 1000) ? claims : undefined;
  }

  // A code is single-use, so A remembers each one it redeemed until it would have expired.
  #redeem(claims: CodeClaims): boolean {
    const now = new Date().toISOString();
    this.#sql.exec('DELETE FROM RedeemedCodes WHERE expiresAt < ?', now);
    const seen = this.#sql.exec('SELECT 1 FROM RedeemedCodes WHERE id = ?', claims.jti).toArray().length > 0;
    if (seen) return false;
    this.#sql.exec('INSERT INTO RedeemedCodes (id, expiresAt) VALUES (?, ?)', claims.jti, new Date(claims.exp * 1000).toISOString());
    return true;
  }
}

function redirect(back: URL, params: Record<string, string | null>): Response {
  const location = new URL(back);
  for (const [name, value] of Object.entries(params)) if (value !== null) location.searchParams.set(name, value);
  return new Response(null, { status: 302, headers: { Location: location.href, 'Cache-Control': 'no-store' } });
}

function oauthError(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status, headers: { 'Cache-Control': 'no-store' } });
}
