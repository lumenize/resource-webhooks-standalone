// The metadata documents a client discovers the authorization server by, which the Worker
// serves without waking A: RFC 9728's protected resource metadata for A's MCP endpoint, and
// RFC 8414's authorization server metadata.

/** A's MCP endpoint, the audience of A's tokens, as `https://….workers.dev/server/A/mcp`. */
export function mcpEndpoint(origin: string, serverInstance: string): string {
  return `${origin}/server/${serverInstance}/mcp`;
}

/** Where A's protected resource metadata lives, the path RFC 9728 derives from the endpoint. */
export function resourceMetadataUrl(origin: string, serverInstance: string): string {
  return `${origin}/.well-known/oauth-protected-resource/server/${serverInstance}/mcp`;
}

export function protectedResourceMetadata(origin: string, serverInstance: string): object {
  return {
    resource: mcpEndpoint(origin, serverInstance),
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationServerMetadata(origin: string): object {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    authorization_response_iss_parameter_supported: true,
  };
}
