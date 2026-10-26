// An MCP client of 2026-07-28 over Streamable HTTP, using only `fetch` and Web Crypto, so a
// browser page, a script and the tests share it. Each request carries the `_meta` envelope and
// the headers that mirror its body, and a `401` starts MCP's authorization flow. It calls an
// extension's methods only on a server that declared the extension. It is one module with no
// relative imports but types, so Node can run it with its types stripped.
import type { DiscoverResult, Implementation, JSONRPCErrorResponse, Result } from '../vendor/mcp-spec/2026-07-28/schema';

export const PROTOCOL_VERSION = '2026-07-28';

/** The JSON-RPC error a request was answered with, and the HTTP status it came with. */
export class McpError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly status: number;

  constructor(status: number, error: JSONRPCErrorResponse['error']) {
    super(error.message);
    this.name = 'McpError';
    this.code = error.code;
    this.data = error.data;
    this.status = status;
  }
}

/** A failure that came without a JSON-RPC error, as a `401` from the edge. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export interface McpClientOptions {
  /** The server's MCP endpoint, as `https://….workers.dev/server/A/mcp`. */
  endpoint: string;
  clientInfo?: Implementation;
  /** Signs in when the server answers `401`, and keeps the token for later requests. */
  oauth?: OAuthSession;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface McpClient {
  /** Sends one request and answers its result, or throws an `McpError` or an `HttpError`. */
  request<R extends Result = Result>(method: string, params?: Record<string, unknown>): Promise<R>;
}

// The params `Mcp-Name` mirrors, the first one present.
const NAME_SOURCES: ReadonlyMap<string, readonly string[]> = new Map([
  ['tools/call', ['name']],
  ['resources/read', ['uri']],
  ['prompts/get', ['name']],
  ['events/subscribe', ['name']],
  ['events/unsubscribe', ['name']],
  ['events/poll', ['name']],
  ['events/stream', ['name']],
  ['resources/webhooks/subscribe', ['uri', 'uriTemplate']],
  ['resources/webhooks/unsubscribe', ['uri', 'uriTemplate']],
]);

const EVENTS = 'io.modelcontextprotocol/events';
const RESOURCE_WEBHOOKS = 'io.modelcontextprotocol/resource-webhooks';

// The extension each of these methods belongs to, which the server must have declared.
const EXTENSION_OF: ReadonlyMap<string, string> = new Map([
  ['events/list', EVENTS],
  ['events/subscribe', EVENTS],
  ['events/unsubscribe', EVENTS],
  ['events/poll', EVENTS],
  ['events/stream', EVENTS],
  ['resources/webhooks/subscribe', RESOURCE_WEBHOOKS],
  ['resources/webhooks/unsubscribe', RESOURCE_WEBHOOKS],
]);

/** A method the client would not call, since the server has not declared its extension. */
export class ExtensionNotDeclaredError extends Error {
  // Fields, not parameter properties, which Node's type stripping cannot run.
  readonly extension: string;
  readonly method: string;

  constructor(extension: string, method: string) {
    super(`The server has not declared ${extension}, so the client does not call ${method}`);
    this.name = 'ExtensionNotDeclaredError';
    this.extension = extension;
    this.method = method;
  }
}

export function createMcpClient({ endpoint, clientInfo, oauth, fetch: send = fetch }: McpClientOptions): McpClient {
  let nextId = 1;
  // The extensions the server declared, learned once from server/discover.
  let extensions: Promise<Record<string, unknown>> | undefined;
  const client: McpClient = {
    async request<R extends Result>(method: string, params: Record<string, unknown> = {}): Promise<R> {
      const extension = EXTENSION_OF.get(method);
      if (extension) {
        extensions ??= client.request<DiscoverResult>('server/discover').then(
          (result) => result.capabilities.extensions ?? {},
          (error: unknown) => {
            extensions = undefined;
            throw error;
          },
        );
        if (!(extension in (await extensions))) throw new ExtensionNotDeclaredError(extension, method);
      }
      const id = nextId++;
      const meta = {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
        ...(clientInfo ? { 'io.modelcontextprotocol/clientInfo': clientInfo } : {}),
      };
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        'Mcp-Method': method,
      };
      const name = NAME_SOURCES.get(method)?.map((source) => params[source]).find((value) => typeof value === 'string');
      if (name !== undefined) headers['Mcp-Name'] = headerValue(name as string);
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } });
      const post = (token: string | undefined) =>
        // A redirect would carry the token on to wherever it points, so none is followed, and a
        // 3xx fails as any answer without a result does. Workers offers no "error" mode.
        send(endpoint, { method: 'POST', headers: token ? { ...headers, Authorization: `Bearer ${token}` } : headers, body, redirect: 'manual' });

      let response = await post(oauth?.cachedToken(endpoint));
      // A 401 asks for a token, and a 403 naming insufficient_scope for one with more scope.
      const challenge = response.headers.get('WWW-Authenticate');
      const stepUp = response.status === 403 && /error="?insufficient_scope/.test(challenge ?? '');
      if (oauth && (response.status === 401 || stepUp)) {
        response = await post(await oauth.tokenFor(endpoint, challenge, { refresh: true }));
      }
      const text = await response.text();
      let message: { result?: R; error?: JSONRPCErrorResponse['error'] } | undefined;
      try {
        message = JSON.parse(text);
      } catch {
        message = undefined;
      }
      if (message?.error && typeof message.error.code === 'number') throw new McpError(response.status, message.error);
      if (!response.ok || !message?.result) throw new HttpError(response.status, text);
      if (method === 'server/discover') extensions = Promise.resolve((message.result as unknown as DiscoverResult).capabilities.extensions ?? {});
      return message.result;
    },
  };
  return client;
}

// A value a plain header cannot carry, or one that looks like the sentinel, goes as Base64.
export function headerValue(value: string): string {
  const plain = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value);
  if (plain && !/^=\?base64\?.*\?=$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  return `=?base64?${btoa(String.fromCharCode(...bytes))}?=`;
}

// The client half of MCP's authorization: from a 401's WWW-Authenticate, or the well-known
// URIs, to the protected resource's metadata, its authorization server's metadata, a
// registration, the code flow with PKCE, and a token for exactly the resource the metadata names.

export interface ClientCredentials {
  /** The authorization server that issued them. Without it, they are bound to the first one met. */
  issuer?: string;
  clientId: string;
  clientSecret?: string;
}

export interface OAuthOptions {
  /** The redirect URI the client registers and is sent back to. */
  redirectUri: string;
  clientName?: string;
  /** Credentials registered beforehand, used in place of registering, with their issuer only. */
  client?: ClientCredentials;
  /**
   * Opens the authorization URL and answers the URL the authorization server sent the browser
   * back to. The default reads the first redirect with `fetch`, which works in a script where
   * consent is granted at once, as it is here. A browser page passes its own, since a page's
   * fetch cannot read a redirect.
   */
  authorize?: (url: string) => Promise<string>;
  fetch?: typeof fetch;
}

interface ServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
}

/** A step of the authorization flow that failed, with the OAuth `error` the server answered, if any. */
export class OAuthError extends Error {
  readonly error?: string;

  constructor(message: string, error?: string) {
    super(message);
    this.name = 'OAuthError';
    this.error = error;
  }
}

const AUTH_METHODS = ['client_secret_post', 'client_secret_basic', 'none'];

export class OAuthSession {
  readonly #options: OAuthOptions;
  readonly #fetch: typeof fetch;
  // Credentials per issuer, since a client id is unique to the server that issued it.
  readonly #clients = new Map<string, ClientCredentials & { method: string; registered: boolean }>();
  #preRegisteredIssuer: string | undefined;
  // Tokens per endpoint or resource they were got for, and the scope each was asked for.
  readonly #tokens = new Map<string, string>();
  readonly #scopes = new Map<string, Set<string>>();

  constructor(options: OAuthOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  /** The token last got for `endpoint`, if any. */
  cachedToken(endpoint: string): string | undefined {
    return this.#tokens.get(endpoint);
  }

  /**
   * A token for the resource at `endpoint`, given the challenge its 401 carried, if any. It
   * answers the token already got unless `refresh` asks for a new one.
   */
  async tokenFor(endpoint: string, challenge?: string | null, { refresh = false } = {}): Promise<string> {
    const cached = this.#tokens.get(endpoint);
    if (cached && !refresh) return cached;
    const parsed = parseChallenge(challenge ?? '');
    const resource = await this.#resourceMetadata(endpoint, parsed.resource_metadata);
    // RFC 9728 § 3.3: metadata naming another resource must not be used.
    const named = resource.resource;
    if (endpoint !== named && !endpoint.startsWith(named.endsWith('/') ? named : `${named}/`)) {
      throw new OAuthError(`The protected resource metadata names ${named}, not ${endpoint}`);
    }
    const issuer = resource.authorization_servers?.[0];
    if (!issuer) throw new OAuthError('The protected resource metadata names no authorization server');
    // A step-up asks for the scope already granted as well as what the server now needs.
    const scopes = this.#scopes.get(endpoint) ?? new Set<string>();
    for (const name of (parsed.scope ?? resource.scopes_supported?.join(' ') ?? '').split(' ')) if (name) scopes.add(name);
    this.#scopes.set(endpoint, scopes);
    const token = await this.tokenForResource(issuer, named, scopes.size > 0 ? [...scopes].join(' ') : undefined);
    this.#tokens.set(endpoint, token);
    return token;
  }

  /**
   * A token from `issuer` for a `resource` no metadata names, as `b`'s socket on B, whose
   * audience is the socket's own URL.
   */
  async tokenForResource(issuer: string, resource: string, scope?: string): Promise<string> {
    const server = await this.#serverMetadata(issuer);
    const client = await this.#client(server);
    try {
      return await this.#codeFlow(server, client, resource, scope);
    } catch (error) {
      // A server that forgot this client, as after a Wipe, is registered with again, once.
      if (!(error instanceof OAuthError) || error.error !== 'invalid_client' || !client.registered) throw error;
      this.#clients.delete(server.issuer);
      return this.#codeFlow(server, await this.#client(server), resource, scope);
    }
  }

  /** The client id this session registered with `issuer`, once it has. */
  clientIdFor(issuer: string): string | undefined {
    return this.#clients.get(issuer)?.clientId;
  }

  async #resourceMetadata(
    endpoint: string,
    advertised: string | undefined,
  ): Promise<{ resource: string; authorization_servers?: string[]; scopes_supported?: string[] }> {
    const url = new URL(endpoint);
    const candidates = advertised
      ? [advertised]
      : [`${url.origin}/.well-known/oauth-protected-resource${url.pathname}`, `${url.origin}/.well-known/oauth-protected-resource`];
    for (const candidate of candidates) {
      const response = await this.#fetch(candidate, { headers: { Accept: 'application/json' } });
      if (response.ok) return (await response.json()) as { resource: string };
    }
    throw new OAuthError(`No protected resource metadata for ${endpoint}`);
  }

  async #serverMetadata(issuer: string): Promise<ServerMetadata> {
    const url = new URL(issuer);
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    const candidates = path
      ? [
          `${url.origin}/.well-known/oauth-authorization-server${path}`,
          `${url.origin}/.well-known/openid-configuration${path}`,
          `${url.origin}${path}/.well-known/openid-configuration`,
        ]
      : [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
    for (const candidate of candidates) {
      const response = await this.#fetch(candidate, { headers: { Accept: 'application/json' } });
      if (!response.ok) continue;
      const metadata = (await response.json()) as ServerMetadata;
      // RFC 8414 § 3.3: metadata for another issuer must not be used.
      if (metadata.issuer !== issuer) throw new OAuthError(`Metadata at ${candidate} names the issuer ${metadata.issuer}, not ${issuer}`);
      // MCP requires PKCE, and a server that does not say it offers S256 may not.
      if (!metadata.code_challenge_methods_supported?.includes('S256')) {
        throw new OAuthError(`The authorization server at ${issuer} does not say it offers PKCE with S256`);
      }
      return metadata;
    }
    throw new OAuthError(`No authorization server metadata for ${issuer}`);
  }

  async #client(server: ServerMetadata): Promise<ClientCredentials & { method: string; registered: boolean }> {
    const known = this.#clients.get(server.issuer);
    if (known) return known;
    // RFC 8414 says client_secret_basic is the default when the server lists none.
    const supported = server.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    const method = AUTH_METHODS.find((candidate) => supported.includes(candidate)) ?? supported[0];
    let client: ClientCredentials & { method: string; registered: boolean };
    const preRegistered = this.#options.client;
    // Credentials issued by one authorization server are never sent to another.
    const issuerOfPreRegistered = preRegistered?.issuer ?? this.#preRegisteredIssuer ?? server.issuer;
    if (preRegistered && issuerOfPreRegistered === server.issuer) {
      this.#preRegisteredIssuer = server.issuer;
      client = { ...preRegistered, method: preRegistered.clientSecret ? method : 'none', registered: false };
    } else {
      if (!server.registration_endpoint) throw new OAuthError('The authorization server offers no registration');
      const response = await this.#fetch(server.registration_endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          redirect_uris: [this.#options.redirectUri],
          client_name: this.#options.clientName ?? 'resource-webhooks client',
          // SEP-2207 asks for refresh_token here, though this client never uses a refresh token.
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: method,
          application_type: /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(this.#options.redirectUri) ? 'native' : 'web',
        }),
      });
      if (!response.ok) throw new OAuthError(`Registration failed with ${response.status}: ${await response.text()}`);
      const registered = (await response.json()) as { client_id: string; client_secret?: string; token_endpoint_auth_method?: string };
      client = { clientId: registered.client_id, clientSecret: registered.client_secret, method: registered.token_endpoint_auth_method ?? method, registered: true };
    }
    this.#clients.set(server.issuer, client);
    return client;
  }

  async #codeFlow(server: ServerMetadata, client: ClientCredentials & { method: string; registered: boolean }, resource: string, scope: string | undefined): Promise<string> {
    const verifier = randomBase64url(32);
    const state = randomBase64url(16);
    const authorization = new URL(server.authorization_endpoint);
    const params: Record<string, string | undefined> = {
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: this.#options.redirectUri,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: 'S256',
      state,
      resource,
      scope,
    };
    for (const [name, value] of Object.entries(params)) if (value) authorization.searchParams.set(name, value);

    const back = new URL(await (this.#options.authorize ?? ((url) => this.#followRedirect(url)))(authorization.href));
    if (back.searchParams.get('state') !== state) throw new OAuthError('The authorization response carries another state');
    // RFC 9207: an issuer in the response must be the one asked, and must be there if promised,
    // and until it checks out, nothing else in the response is acted on, an error included.
    const iss = back.searchParams.get('iss');
    if (iss !== null ? iss !== server.issuer : server.authorization_response_iss_parameter_supported) {
      throw new OAuthError('The authorization response names another issuer, or none');
    }
    const error = back.searchParams.get('error');
    if (error) throw new OAuthError(`Authorization failed: ${error} ${back.searchParams.get('error_description') ?? ''}`.trim(), error);
    const code = back.searchParams.get('code');
    if (!code) throw new OAuthError('The authorization response carries no code');

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.#options.redirectUri,
      code_verifier: verifier,
      resource,
      client_id: client.clientId,
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (client.method === 'client_secret_post' && client.clientSecret) form.set('client_secret', client.clientSecret);
    if (client.method === 'client_secret_basic' && client.clientSecret) {
      headers.Authorization = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`;
    }
    const response = await this.#fetch(server.token_endpoint, { method: 'POST', headers, body: form.toString(), redirect: 'manual' });
    if (!response.ok) {
      const text = await response.text();
      throw new OAuthError(`The token request failed with ${response.status}: ${text}`, oauthErrorCode(text));
    }
    const { access_token: token } = (await response.json()) as { access_token?: string };
    if (!token) throw new OAuthError('The token response carries no access_token');
    return token;
  }

  async #followRedirect(url: string): Promise<string> {
    const response = await this.#fetch(url, { redirect: 'manual' });
    const location = response.headers.get('Location');
    if (response.status < 300 || response.status >= 400 || !location) {
      const text = await response.text();
      throw new OAuthError(`The authorization endpoint answered ${response.status} without a redirect: ${text}`, oauthErrorCode(text));
    }
    return new URL(location, url).href;
  }
}

function oauthErrorCode(text: string): string | undefined {
  try {
    const { error } = JSON.parse(text) as { error?: unknown };
    return typeof error === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
}

/** The parameters of a `Bearer` challenge, as RFC 9110 and RFC 6750 write them. */
export function parseChallenge(header: string): Record<string, string | undefined> {
  const params: Record<string, string> = {};
  for (const match of header.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params[match[1]] = match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3];
  }
  return params;
}

function randomBase64url(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
