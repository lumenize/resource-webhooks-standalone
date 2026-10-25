# SEP notes

The requirements of the SEP this prototype will become, in RFC 2119's words: MUST, SHOULD and MAY. Each gets a number that is never reused, so a conformance traceability file can cite it. The scenarios in `tasks/master-plan.md` show most of them at work, and each names the ones it shows.

These notes are for the design's second level, resource state sync. The first level, `mcp.resource.updated` over Events, needs nothing beyond SEP-3415 and the type its Open Question 2 sketches, so it adds no requirement here. It shares A's webhook code with the second level, and with it N3, within SEP-3415's room.

## Departures from SEP-3415

**This extension takes SEP-3415's webhook delivery by reference, and goes against its text in one place.** Each departure says what it needs from Peter.

- **D1. The reserved header and well-known paths are reused (R17).** SEP-3415 reserves them for Events: "The HTTP header `X-MCP-Subscription-Id`, and the well-known paths `/.well-known/mcp-webhook-receiver.json` and `/.well-known/mcp-webhook-jwks.json`, are reserved for this extension." Resource webhooks uses all three, with the meanings SEP-3415 gives them. Read as barring other meanings, the reservation allows that, and read as barring other uses, it does not. Reuse lets one receiver, with one receiver document on its origin, serve both extensions without telling their deliveries apart, and SEP-3415's own wording is general: its receiver document declares paths that accept "MCP webhook deliveries", and "MCP webhook delivery is a profile" of Standard Webhooks. It needs Peter to agree that the reservation bars other meanings, not other uses. If he does not, this extension names a header and paths of its own, and a receiver that serves both handles two sets. The JWKS path may yet go: SEP-3415 is still choosing between it and SEP-2127's server cards as the place to publish the optional signing key (Clare Liguori, 2026-10-19, and Peter, 2026-10-23, on its thread).

## Narrowings of SEP-3415

**Where SEP-3415 leaves a server room, this extension makes a choice within it.** None of these conflicts with SEP-3415's text:

- **N1. Coalesced retries, in order per URI (R12, R13).** SEP-3415 describes retrying each event independently, with deliveries that may arrive out of order. It requires neither: it caps retries, sets no minimum, and lets a server abandon a delivery. Here a newer version replaces a pending older one, so a URI's deliveries arrive in version order. Peter agreed on SEP-3415's thread, on 2026-10-16, that an event type may coalesce, and that coalescing should not set `truncated`.
- **N3. The subscription `id` is a keyed hash (R25),** where SEP-3415 asks only that it be deterministic.
- **N4. A body too large for the `full` form goes as `notify` (R27),** keeping every body within SEP-3415's 256 KiB delivery profile.
- **N6. Contents travel only on request (R5, R10).** SEP-3415's § *Payload minimality* says "Servers SHOULD keep event payloads minimal: enough to identify and triage the event, and not the full content." The default form, `notify`, does, naming only the resource and its version. A subscriber that asks for `full`, for its deliveries or for a catch-up, gets the contents, because sparing it a read is the point of resource state sync, and a server need not offer `full` at all (R1). A SHOULD leaves room for a reason that is understood, and here the subscriber gives it by asking. SEP-3415's own Open Question 6 sketches a task event whose payload may carry the task's `result`.

## The capability

- **R1.** A server that offers this extension MUST declare `io.modelcontextprotocol/resource-webhooks` in `capabilities.extensions`, with a settings object whose `forms` lists the forms it delivers. `notify` MUST be among them.
- **R2.** A client MUST NOT call this extension's methods on a server that has not declared it.

## Versions

- **R3.** A resource that a server accepts subscriptions to, other than a collection (R38), MUST have a version: an opaque string that changes whenever the resource's contents change, and is never reused for the same URI, with the semantics of HTTP's `ETag`. Clients MUST compare versions only for equality. Versions are not required to sort in time. A server whose versions do sort MAY rely on that in its own implementation.
- **R4.** For a resource that R3 covers and that has an `https` URI, the version MUST be the characters between the quotes of the resource's strong `ETag`, so that a client can send it, quoted, in `If-None-Match`.
- **R37.** A server MUST answer for a resource with no version, one never written or one whose deletion it no longer keeps, as R11 answers for a deletion, at a base version the server mints.

## Subscribing: `resources/webhooks/subscribe`

- **R5.** The request carries exactly one target (`uri`, `uriTemplate`, or `listed: true`), an optional `form`, an optional `version` naming the version the client holds of the resource a `uri` target names, an optional `cursor` for a collection (R32), an optional `catchUp` naming the result's form, `delivery` with `url` and `secret`, and an optional `ttlMs`. A request without `form` gets `notify` deliveries, and one without `catchUp` gets a `notify` result. The two are independent. A `form` it names MUST be one the server declared.
- **R6.** The subscription key is `(principal, delivery.url, target)`, with `delivery.url` compared as an exact string, and the target compared as its kind and its value (`uri`, `uriTemplate` or `listed`). A request whose key matches an existing subscription refreshes it: the server grants a TTL again, and replaces `form` and `delivery.secret`.
- **R7.** A server MUST refuse a `uri` it could never serve, such as one with a scheme it does not serve or one outside all its templates, with the error `resources/read` gives for it. A `uri` that names a deleted resource is not refused, by R11. It MUST refuse a `form` it did not declare with SEP-3415's `Unsupported`, with `data` `{"feature": "form", "value": ...}`.
- **R8.** The result MUST carry `id` and `refreshBefore`. For a `uri` target naming a resource that is not a collection, it MUST also carry that resource's current `version`, with `deleted: true` when that version deleted it, and, when the request's `catchUp` is `full` and its `version` is absent or differs, the resource's `contents`, as `resources/read` would return them. For a collection, it carries what R32 to R35 say.

## Delivering a change

- **R10.** When a resource the subscription covers changes, the server MUST deliver a `ResourceChange` with that resource's `uri`, the `form` and its new `version`. In the `full` form, the delivery MUST also carry `contents` (N6).
- **R11.** When a resource the subscription covers is deleted, the server MUST mint a version for the deletion, like any other version, and deliver `{"uri": ..., "form": "notify", "version": ..., "deleted": true}`, whatever the subscription's form. The subscription MUST carry on.
- **R12.** A server MUST keep at most one delivery in flight per subscription and URI. When a newer version of a resource lands while an older one is pending or being retried, the server MUST deliver the newer one in its place (N1).
- **R13.** A server MUST NOT deliver a version of a resource after delivering a newer one to the same subscription. It MAY skip intermediate versions (N1).
- **R14.** One message, in SEP-3415's sense of `webhook-id`, is one version of one URI on one subscription. Its `webhook-id` is the same for every retry, and a newer version that replaces a pending one is a new message, with a new `webhook-id`.
- **R15.** A client SHOULD ignore a delivery naming a version it already holds, and SHOULD pass the version it holds of the resource a `uri` target names in `version` on every refresh.
- **R26.** A `ResourceChange` MUST NOT carry a top-level `type`, so that SEP-3415's rule tells it apart from a control envelope.
- **R27.** In the `full` form, a server MUST deliver a change in the `notify` form instead when its body would exceed the 256 KiB bound that SEP-3415's delivery profile recommends (N4).
- **R28.** A receiver's `410 Gone` stops the server retrying that version only, as SEP-3415 leaves the subscription unaffected. The server MUST still deliver the resource's later versions (R17).
- **R30.** A receiver that acts for a client, as a gateway does in SEP-3415's forward-proxy deployment, MUST make each `ResourceChange` it accepts available to that client whole, as SEP-3415 requires of `cursor` and `eventId`.
- **R31.** A client that may have missed deliveries, for example because its gateway could not reach it, SHOULD refresh each of its subscriptions.

## Unsubscribing: `resources/webhooks/unsubscribe`

- **R16.** The request carries the target and `delivery.url`, which with the caller's principal identify the subscription. The result is empty. A request that matches no subscription is refused with SEP-3415's `NotFound`, with `data.kind` `"subscription"`.

## Taken from SEP-3415 by reference

- **R17.** Webhook delivery follows SEP-3415's § *Webhook-Based Delivery*, at commit b0efd11, with these substitutions: this extension's methods for `events/subscribe` and `events/unsubscribe`, R6's key for SEP-3415's subscription key, a `ResourceChange` for an `EventOccurrence`, a change's `uri` and `version` for an event's `eventId`, and one version of one URI for the delivery that SEP-3415's `410` rule stops, so later versions still go (R28). It also takes SEP-3415's § *Authorization* by reference, re-verifying at delivery time, with the target in place of an event type and its arguments, and R39 adds what that means for a collection. Everything else is narrowed as N1, N3, N4 and N6 say. SEP-3415's `cursor`, `maxAgeMs`, `truncated` and `gap` envelope never apply: one resource needs only its version, and a collection uses this extension's own `cursor` (R32 to R35), with `reset` (R34) in place of `truncated`.
- **R29.** This extension uses SEP-3415's general-purpose error codes as SEP-3415 defines them: `Forbidden` for a principal refused or missing, `ResourceExhausted` for a server limit, `CallbackEndpointError` for a callback that fails verification or cannot be reached, plus `Unsupported` (R7) and `NotFound` (R16).
- **SEP-3415's § *SSRF prevention* is met by the platform on Cloudflare Workers, as far as one measurement shows.** SEP-3415 asks a server to check a callback's resolved address at delivery time and connect to that address. A Worker's `fetch()` can do neither, since it takes no address and offers no DNS lookup.
  - **Measured on 2026-10-25,** at compatibility date 2026-10-01 with `global_fetch_strictly_public`, by a test Worker fetching fixed sslip.io and nip.io names that each resolve to one address. Cloudflare answered with its own error page for an address in every range SEP-3415 names: 127.0.0.1, 10.0.0.1, 172.16.0.1, 192.168.0.1, 169.254.169.254, `::1`, `fc00::1` and `fe80::1`. It did the same for 0.0.0.0, 100.64.0.1, 198.18.0.1, 198.51.100.1, 203.0.113.1, 224.0.0.1, 240.0.0.1, 255.255.255.255, `2001:db8::1`, `64:ff9b::a00:1` and `::ffff:127.0.0.1`, for the private IP literals 10.0.0.1 and 127.0.0.1, and for `localhost`. Google's address through the same two services was reached.
  - **Three addresses went out and timed out:** 192.0.0.1 and 192.0.0.8, in 192.0.0.0/24, and 192.0.2.1, in 192.0.2.0/24. SEP-3415's SHOULD covers both ranges.
  - **A name whose answer alternates** between Google's address and 10.0.0.1 reached Google on all 14 fetches over about 20 seconds, so the private answer was never used.
  - **Inferred, not measured:** the error codes, 1016 from Cloudflare's resolver and 1002 for a prohibited address, suggest Cloudflare checks each answer as it connects, which would leave DNS rebinding nothing to exploit.
  - **The Worker fetches with `redirect: "manual"`,** and treats any `3xx` as a failed delivery, since SEP-3415 forbids following one.
  - **SEP-3415 could say that a platform whose outbound requests refuse the ranges it names meets its delivery-time MUST,** as Workers' `fetch()` does for every example SEP-3415 gives.

## Collections

- **R18.** A `uri` target covers that resource and its sub-resources. A delivery for a sub-resource names the sub-resource's own `uri`. A collection's own contents change only as its members do, so a server delivers its members' changes and nothing for the collection itself.
- **R19.** A `uriTemplate` target covers every resource whose URI matches the template, and their sub-resources. A simple `{name}` expression matches exactly one path segment, and a reserved expansion `{+name}` matches one or more characters, slashes included. RFC 6570 defines expansion, not matching, so a server MAY refuse a template with any other expression, with `Unsupported`.
- **R20.** A `listed: true` target covers every resource `resources/list` returns to the subscription's principal.
- **R38.** A collection is a resource whose `resources/read` returns its members as entries with URIs of their own. Which of its URIs are collections is the server's to decide, and a subscription's kind MUST NOT change during its life, whatever its number of members. A `uriTemplate` or `listed` target is always a collection.
- **R39.** For a collection, a server MUST deliver only the members the principal may read, and MUST end the subscription, with SEP-3415's `terminated` envelope, only when the principal may read none of them, or, for a `uri` target, may no longer read the collection itself. The prototype does not exercise this or SEP-3415's re-verification, since everyone may read A's notes, and builds no revocation only to trigger it.
- **R32.** For a collection, the result MUST carry a `cursor`, and a refresh MAY name the `cursor` of an earlier result. The result's `changes` MUST then hold every covered resource whose newest version came after that cursor, once each and at its newest version, as a `ResourceChange` in the form the request's `catchUp` names, with a deleted one as R11 delivers it. Without a cursor, `changes` MUST hold every covered resource that exists. A client SHOULD name the cursor of its last result on every refresh.
- **R33.** A delivery MUST NOT carry a cursor, since deliveries may overlap and arrive out of order.
- **R34.** When a server can no longer tell which covered resources changed after the named cursor, it MUST answer as though none were named, and set `reset: true`. A client that receives `reset: true` MUST treat as deleted every resource it holds under the target that no page of the reset lists. A server MUST NOT answer a stale cursor with an error.
- **R35.** A server MAY split `changes` across results. A result that stops partway MUST set `hasMore: true`, with a `cursor` that resumes where it stopped, and a client SHOULD refresh again with that cursor until a result arrives without `hasMore`.
- **R36.** A server MAY make cursors and versions one value, stamped from one ordered counter. A client MUST NOT rely on that: it compares versions only for equality, and passes a cursor back unchanged.

## Who may subscribe

- **R22.** Both methods MUST be called with an authenticated principal, as SEP-3415 defines it. A server MUST refuse, with `Forbidden`, a principal that may not read the resource a `uri` target names. For a collection, it filters the members instead (R39).
- **R25.** A server MUST derive a subscription's `id` from its key with a keyed hash, so that a logged `id` cannot confirm a guessed principal (N3).

## Pending

- **The methods' prefix.** `resources/` belongs to the core specification, so the PR asks the working group whether an extension's methods want a prefix of their own.
- **The `_meta` key** under which `resources/read` carries the version of a resource without an `https` URI, to be agreed with the Filesystems working group, with the Transports working group's Definition Tags in view.
- **The `patch` form's rules,** written in its phase.
- **Two gaps inherited from SEP-3415:** which base64 alphabet the secret uses, and whether a result should also return the granted TTL, since `refreshBefore` is a clock time and a client's clock can be skewed.
- **A flood SEP-3415 leaves open, for the PR.** Through the allowlist, out-of-band verification or the receiver's well-known document, a principal can aim deliveries at a receiver that never held its secret. The receiver can only reject them, and SEP-3415 retries a rejection, suspends only after a sustained failure rate, and lets a refresh reactivate the subscription. A rule closes it: a receiver answers a delivery it cannot verify with `401`, and a server treats that as consent withdrawn, stops delivering, and forgets its verification for `(principal, url)`, so the next subscribe needs a handshake the receiver can refuse.

## Out of scope, to list in the SEP

- **Polling.** A client polls an `https` resource with a conditional `GET`, and any other with `resources/read`.
- **Delivery over an open stream,** as SEP-3415's `events/stream` offers for events, until `subscriptions/listen` opens its filter to extensions, as proposed on SEP-3415's thread.
- **How a gateway reaches its client.** SEP-3415 leaves that channel to the endpoint, and so does this extension.
- **A mirror,** where a subscriber keeps copies at the server's versions and serves them to readers of its own. It needs nothing from this extension that a client does not, and is not covered for now.

## Withdrawn

- **R9** (a MUST to end a subscription whose principal can no longer read what it covers), withdrawn 2026-10-25 in favour of SEP-3415's § *Authorization*, which R17 takes by reference, and R39.
- **N5** (a receiver's `410` stops one version), moved 2026-10-25 into R17's substitutions, since it follows from R14 and SEP-3415's `410` rule.
- **N2 and R24** (verification cached per `(principal, delivery.url, delivery.secret)`), withdrawn 2026-10-25: a verified principal can point a URL at any number of targets with no new handshake either way, and a challenge on rotation would fail a stock Events receiver.
- **R21** (a version for a whole collection), withdrawn 2026-10-25 when a collection's catch-up came to name a cursor.
- **R23** (callers without credentials share one anonymous principal), withdrawn 2026-10-20 when subscribing came to require an authenticated principal.
