# SEP notes

The requirements of the SEP this prototype will become, in RFC 2119's words: MUST, SHOULD and MAY. Each gets a number that is never reused, so a conformance traceability file can cite it. The scenarios in `tasks/master-plan.md` show each one at work.

These notes are for the design's second level, resource state sync. The first level, `mcp.resource.updated` over Events, needs nothing beyond SEP-3415 and the type its Open Question 2 sketches, so it adds no requirement here.

## Departures from SEP-3415

**This extension takes SEP-3415's webhook delivery by reference, and goes against its text in one place.** Each departure says what it needs from Peter.

- **D1. The reserved header and well-known paths are reused (R17).** SEP-3415 reserves them for Events: "The HTTP header `X-MCP-Subscription-Id`, and the well-known paths `/.well-known/mcp-webhook-receiver.json` and `/.well-known/mcp-webhook-jwks.json`, are reserved for this extension." Resource webhooks uses all three, with the meanings SEP-3415 gives them. Read as barring other meanings, the reservation allows that, and read as barring other uses, it does not. Reuse lets one receiver, with one receiver document on its origin, serve both extensions without telling their deliveries apart. It needs Peter to agree that the reservation bars other meanings, not other uses. If he does not, this extension names a header and paths of its own, and a receiver that serves both handles two sets. The JWKS path may yet go: SEP-3415 is still choosing between it and SEP-2127's server cards as the place to publish the optional signing key (Clare Liguori, 2026-10-19, and Peter, 2026-10-23, on its thread).

## Narrowings of SEP-3415

**Where SEP-3415 leaves a server room, this extension makes a choice within it.** None of these conflicts with SEP-3415's text:

- **N1. Coalesced retries, in order per URI (R12, R13).** SEP-3415 describes retrying each event independently, with deliveries that may arrive out of order. It requires neither: it caps retries, sets no minimum, and lets a server abandon a delivery. Here a newer version replaces a pending older one, so a URI's deliveries arrive in version order. Peter agreed on SEP-3415's thread, on 2026-10-16, that an event type may coalesce, and that coalescing should not set `truncated`.
- **N2. Verification is cached per `(principal, delivery.url, delivery.secret)` (R24),** adding the secret to SEP-3415's `(principal, url)`. It sends a handshake SEP-3415 would skip, when a principal brings a new secret, and never skips one SEP-3415 would send. Without it, a principal that verified a webhook URL once could subscribe it again with a secret the receiver never held, and flood it. The same fix would serve SEP-3415.
- **N3. The subscription `id` is a keyed hash (R25),** where SEP-3415 asks only that it be deterministic.
- **N4. A body too large for the `full` form goes as `notify` (R27),** keeping every body within SEP-3415's 256 KiB delivery profile.
- **N5. A receiver's `410` stops one version (R28).** SEP-3415 makes it non-retryable for that delivery and leaves the subscription unaffected. Under coalescing, a delivery is one version, so later versions still go.
- **N6. Contents travel only on request (R5, R10).** SEP-3415's § *Payload minimality* says "Servers SHOULD keep event payloads minimal: enough to identify and triage the event, and not the full content." The default form, `notify`, does, naming only the resource and its version. A subscriber that asks for `full` gets the contents, because sparing it a read is the point of the state contract, and a server need not offer `full` at all (R1). A SHOULD leaves room for a reason that is understood, and here the subscriber gives it by asking. SEP-3415's own Open Question 6 sketches a task event whose payload may carry the task's `result`.

Everything else in R17 is a substitution: this extension's methods, key and body in place of SEP-3415's.

## The capability

- **R1.** A server that offers this extension MUST declare `io.modelcontextprotocol/resource-webhooks` in `capabilities.extensions`, with a settings object whose `forms` lists the forms it delivers. `notify` MUST be among them.
- **R2.** A client MUST NOT call this extension's methods on a server that has not declared it.

## Versions

- **R3.** A resource that a server accepts subscriptions to MUST have a version: an opaque string that changes whenever the resource's contents change, and is never reused for the same URI, with the semantics of HTTP's `ETag`. Clients MUST compare versions only for equality. Versions are not required to sort in time. A server whose versions do sort MAY rely on that in its own implementation.
- **R4.** For a resource with an `https` URI, the version MUST be the characters between the quotes of the resource's strong `ETag`, so that a client can send it, quoted, in `If-None-Match`.

## Subscribing: `resources/webhooks/subscribe`

- **R5.** The request carries exactly one target (`uri`, `uriTemplate`, or `listed: true`), an optional `form`, an optional `version` naming the target's version the client holds, `delivery` with `url` and `secret`, and an optional `ttlMs`. A request without `form` gets `notify`. A `form` it names MUST be one the server declared.
- **R6.** The subscription key is `(principal, delivery.url, target)`, with `delivery.url` compared as an exact string, and the target compared as its kind and its value (`uri`, `uriTemplate` or `listed`). A request whose key matches an existing subscription refreshes it: the server grants a TTL again, and replaces `form` and `delivery.secret`.
- **R7.** A server MUST refuse a `uri` it could never serve, such as one with a scheme it does not serve or one outside all its templates, with the error `resources/read` gives for it. A `uri` that names a deleted resource is not refused, by R11. It MUST refuse a `form` it did not declare with SEP-3415's `Unsupported`, with `data` `{"feature": "form", "value": ...}`.
- **R8.** The result MUST carry `id` and `refreshBefore`. For a `uri` target naming one resource, it MUST also carry that resource's current `version`, with `deleted: true` when that version deleted it, and in the `full` form, when the request's `version` is absent or differs from it, the resource's `contents`, as `resources/read` would return them. What the result carries for a `uri` naming a collection, and for the other targets, waits on Q1 in the master plan's § *Open questions*.
- **R9.** A server MUST end a subscription with a `terminated` envelope when its principal can no longer read the resources it covers.

## Delivering a change

- **R10.** When a resource the subscription covers changes, the server MUST deliver a `ResourceChange` with that resource's `uri`, the `form` and its new `version`. In the `full` form, the delivery MUST also carry `contents` (N6).
- **R11.** When a resource the subscription covers is deleted, the server MUST mint a version for the deletion, like any other version, and deliver `{"uri": ..., "form": "notify", "version": ..., "deleted": true}`, whatever the subscription's form. The subscription MUST carry on.
- **R12.** A server MUST keep at most one delivery in flight per subscription and URI. When a newer version of a resource lands while an older one is pending or being retried, the server MUST deliver the newer one in its place (N1).
- **R13.** A server MUST NOT deliver a version of a resource after delivering a newer one to the same subscription. It MAY skip intermediate versions (N1).
- **R14.** One message, in SEP-3415's sense of `webhook-id`, is one version of one URI on one subscription. Its `webhook-id` is the same for every retry, and a newer version that replaces a pending one is a new message, with a new `webhook-id`.
- **R15.** A client SHOULD ignore a delivery naming a version it already holds, and SHOULD pass the target's version it holds in `version` on every refresh.
- **R26.** A `ResourceChange` MUST NOT carry a top-level `type`, so that SEP-3415's rule tells it apart from a control envelope.
- **R27.** In the `full` form, a server MUST deliver a change in the `notify` form instead when its body would exceed the 256 KiB bound that SEP-3415's delivery profile recommends (N4).
- **R28.** A receiver's `410 Gone` stops the server retrying that version only, as SEP-3415 leaves the subscription unaffected. The server MUST still deliver the resource's later versions (N5).
- **R30.** A receiver that acts for a client, as a gateway does in SEP-3415's forward-proxy deployment, MUST make each `ResourceChange` it accepts available to that client whole, as SEP-3415 requires of `cursor` and `eventId`.
- **R31.** A client that may have missed deliveries, for example because its gateway could not reach it, SHOULD refresh each of its subscriptions.

## Unsubscribing: `resources/webhooks/unsubscribe`

- **R16.** The request carries the target and `delivery.url`, which with the caller's principal identify the subscription. The result is empty. A request that matches no subscription is refused with SEP-3415's `NotFound`, with `data.kind` `"subscription"`.

## Taken from SEP-3415 by reference

- **R17.** Webhook delivery follows SEP-3415's § *Webhook-Based Delivery*, at commit b0efd11, with these substitutions: this extension's methods for `events/subscribe` and `events/unsubscribe`, R6's key for SEP-3415's subscription key, a `ResourceChange` for an `EventOccurrence`, and a change's `uri` and `version` for an event's `eventId`. It narrows it as N1 to N6 say. SEP-3415's `cursor`, `maxAgeMs`, `truncated` and `gap` envelope do not apply to a target naming one resource. For a collection, they wait on Q1 in the master plan's § *Open questions*.
- **R29.** This extension uses SEP-3415's general-purpose error codes as SEP-3415 defines them: `Forbidden` for a principal refused or missing, `ResourceExhausted` for a server limit, `CallbackEndpointError` for a callback that fails verification or cannot be reached, plus `Unsupported` (R7) and `NotFound` (R16).
- **SEP-3415's § *SSRF prevention* is met by the platform, on Cloudflare Workers.** SEP-3415 asks a server to check a callback's resolved address at delivery time and connect to that address. A Worker's `fetch()` can do neither, since it takes no address and offers no DNS lookup, and Cloudflare makes the check itself on every subrequest, at connection time, so DNS rebinding gains nothing.
  - **Measured on 2026-10-25,** by a test Worker fetching hostnames that resolve to each address, through sslip.io and nip.io. Cloudflare refused, before connecting, every range SEP-3415 names: 127.0.0.1, 10.0.0.1, 172.16.0.1, 192.168.0.1, 169.254.169.254, `::1`, `fc00::1` and `fe80::1`. It also refused 0.0.0.0, 100.64.0.1, 198.18.0.1, 198.51.100.1, 203.0.113.1, 224.0.0.1, 240.0.0.1, 255.255.255.255, `2001:db8::1`, `64:ff9b::a00:1` and `::ffff:127.0.0.1`, and it refused IP literals and `localhost` outright. Google's address through the same two services was reached.
  - **Two special-purpose ranges went out and timed out,** 192.0.0.0/24 and 192.0.2.0/24. SEP-3415's SHOULD covers them, but neither reaches a private network.
  - **The Worker fetches with `redirect: "manual"`,** and treats any `3xx` as a failed delivery, since SEP-3415 forbids following one.
  - **SEP-3415 could say that a platform whose egress refuses non-global addresses meets its delivery-time MUST,** since every serverless server is in this position.

## Collections

- **R18.** A `uri` target covers that resource and its sub-resources. A delivery for a sub-resource names the sub-resource's own `uri`.
- **R19.** A `uriTemplate` target covers every resource whose URI matches the template, and their sub-resources. Each simple `{name}` expression matches exactly one path segment.
- **R20.** A `listed: true` target covers every resource `resources/list` returns to the subscription's principal.

## Who may subscribe

- **R22.** Both methods MUST be called with an authenticated principal, as SEP-3415 defines it. A server MUST refuse a principal that may not read every resource the target covers, with `Forbidden`.
- **R24.** A server MUST cache endpoint verification per `(principal, delivery.url, delivery.secret)`, so that a new secret always faces a new handshake (N2).
- **R25.** A server MUST derive a subscription's `id` from its key with a keyed hash, so that a logged `id` cannot confirm a guessed principal (N3).

## Pending

- **R21, held for Q1 in the master plan's § *Open questions*:** a target that covers more than one resource has a version the server computes for the whole set, which changes whenever a member is added, removed or changed.
- **How a collection catches up, and how its responses page:** Q1 and Q2. If a change cursor is chosen, a cursor too old to serve is answered in the refresh result, never with HTTP `410`, which SEP-3415 already gives a receiver.
- **The extension's names:** Q3.
- **The `_meta` key** under which `resources/read` carries the version of a resource without an `https` URI, to be agreed with the Filesystems working group, with the Transports working group's Definition Tags in view.
- **The `patch` form's rules,** written in its phase.
- **Two gaps inherited from SEP-3415:** which base64 alphabet the secret uses, and whether a result should also return the granted TTL, since `refreshBefore` is a clock time and a client's clock can be skewed.

## Out of scope, to list in the SEP

- **Polling.** A client polls an `https` resource with a conditional `GET`, and any other with `resources/read`.
- **Delivery over an open stream,** as SEP-3415's `events/stream` offers for events, until `subscriptions/listen` opens its filter to extensions, as proposed on SEP-3415's thread.
- **How a gateway reaches its client.** SEP-3415 leaves that channel to the endpoint, and so does this extension.
- **A mirror,** where a subscriber keeps copies at the server's versions and serves them to readers of its own. It needs nothing from this extension that a client does not, and is not covered for now.

## Withdrawn

- **R23** (callers without credentials share one anonymous principal), withdrawn 2026-10-20 when subscribing came to require an authenticated principal.
