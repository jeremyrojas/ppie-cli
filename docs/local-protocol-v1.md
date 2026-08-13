# Prompt Pie Local Companion Protocol v1

Status: frozen for Wave 1.

## Transport and identity

The companion binds only to `127.0.0.1` on an operating-system-selected port. Its protocol identifier is `promptpie.local/v1`.

The production browser origin is `https://app.promptpie.dev`. `ppie pair --origin <origin>` permits an explicit development origin. HTTPS origins and loopback HTTP origins are accepted. Origin matching includes the scheme, host, and port.

The CLI opens this URL:

```text
<allowed-origin>/pair#protocol=promptpie.local%2Fv1&port=<port>&nonce=<base64url>
```

The fragment has exactly three fields:

- `protocol`: `promptpie.local/v1`
- `port`: the loopback companion port
- `nonce`: 24 random bytes encoded as base64url

The nonce expires after 120 seconds and succeeds once. The fragment never contains the browser session token or CLI-private token.

## Endpoints

Browser endpoints:

| Method | Path | Authentication | Request type |
| --- | --- | --- | --- |
| `OPTIONS` | `/v1/pair` | Exact `Origin` | preflight |
| `POST` | `/v1/pair` | Exact `Origin` | `browser.pair` |
| `OPTIONS` | `/v1/browser/poll` | Exact `Origin` | preflight |
| `POST` | `/v1/browser/poll` | Bearer session and exact `Origin` | `browser.poll` |
| `OPTIONS` | `/v1/browser/result` | Exact `Origin` | preflight |
| `POST` | `/v1/browser/result` | Bearer session and exact `Origin` | `browser.result` |

CLI-private endpoints:

| Method | Path | Authentication | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/cli/status` | `X-PromptPie-Token` | health and pairing state |
| `POST` | `/v1/cli/operations` | `X-PromptPie-Token` | pair challenge, prompt operation, clean shutdown |

CLI-private endpoints reject requests that contain an `Origin` header. Unrecognized paths return `404`.

## Envelopes

Every POST request contains exactly:

```json
{
  "protocol": "promptpie.local/v1",
  "requestId": "5b912e69-2884-4e12-aecf-7558a5f6350f",
  "idempotencyKey": "4e1a1311-f1f4-42e8-8967-752b872997d6",
  "type": "browser.poll",
  "payload": {}
}
```

IDs are 8-128 URL-safe characters. Unknown or missing envelope fields are rejected.

Success:

```json
{
  "protocol": "promptpie.local/v1",
  "requestId": "5b912e69-2884-4e12-aecf-7558a5f6350f",
  "ok": true,
  "type": "browser.poll",
  "payload": {}
}
```

Failure:

```json
{
  "protocol": "promptpie.local/v1",
  "requestId": "5b912e69-2884-4e12-aecf-7558a5f6350f",
  "ok": false,
  "error": {
    "code": "CLI_NOT_PAIRED",
    "message": "Prompt Pie browser is disconnected. Run \"ppie pair\".",
    "details": {}
  }
}
```

Error text and details are redacted before crossing the companion boundary.

## Pairing

`POST /v1/pair`:

```json
{
  "type": "browser.pair",
  "payload": {
    "nonce": "<fragment nonce>",
    "client": { "name": "promptpie-web", "version": "<web version>" }
  }
}
```

Response payload:

```json
{
  "session": {
    "id": "<opaque id>",
    "token": "<bearer token>",
    "expiresAt": "2026-08-13T12:00:00.000Z"
  },
  "companion": { "protocol": "promptpie.local/v1", "version": "0.1.0" }
}
```

The browser sends `Authorization: Bearer <token>` for polling and results. The session lasts 12 hours. A successful later pair replaces the active session. The browser may use same-tab `sessionStorage` for reload continuity. It clears the token after `401`, `CLI_NOT_PAIRED`, or `CLI_INCOMPATIBLE`.

## Polling and operations

The browser keeps one long poll open and starts another after every response:

```json
{ "type": "browser.poll", "payload": { "waitMs": 25000 } }
```

`waitMs` is an integer from 0 through 25,000. An idle poll returns:

```json
{ "operation": null }
```

A push operation is:

```json
{
  "operation": {
    "operationId": "<uuid>",
    "kind": "prompt.push",
    "prompt": {
      "id": "welcome",
      "title": "Welcome",
      "content": "Say hello",
      "revision": "<sha256>"
    },
    "expectedRevision": null
  }
}
```

A pull operation is:

```json
{
  "operation": {
    "operationId": "<uuid>",
    "kind": "prompt.pull",
    "promptId": "welcome"
  }
}
```

The browser completes either operation at `/v1/browser/result`:

```json
{
  "type": "browser.result",
  "payload": {
    "operationId": "<uuid>",
    "result": {
      "prompt": {
        "id": "welcome",
        "title": "Welcome",
        "content": "Say hello",
        "revision": "<sha256>"
      }
    }
  }
}
```

An operation failure uses:

```json
{
  "type": "browser.result",
  "payload": {
    "operationId": "<uuid>",
    "error": {
      "code": "CLI_REVISION_CONFLICT",
      "message": "The prompt changed in Prompt Pie.",
      "details": { "expectedRevision": "<sha256>", "actualRevision": "<sha256>" }
    }
  }
}
```

The result endpoint acknowledges success with `{ "accepted": true }`.

## Prompt revision

A prompt has exactly `id`, `title`, `content`, and `revision` on the wire.

- `id`: 1-128 characters; starts alphanumeric; remaining characters may be alphanumeric, `.`, `:`, `_`, or `-`
- `title`: UTF-8 string up to 4 KiB
- `content`: UTF-8 string up to 1 MiB
- `revision`: lowercase SHA-256 hex

Calculate the revision from the UTF-8 bytes of:

```js
JSON.stringify({ id: prompt.id, title: prompt.title, content: prompt.content })
```

The field order shown above is part of the hash contract. Push input may omit `revision`; the CLI calculates it. A supplied revision must match. `expectedRevision` is a nullable optimistic-concurrency condition. The browser returns `CLI_REVISION_CONFLICT` with expected and actual revisions when the condition fails.

## Idempotency, timeouts, and restart

Identical repeats of a request ID or idempotency key replay their first response for 10 minutes. Reuse with changed content returns `CLI_IDEMPOTENCY_CONFLICT`. A repeated result returns its original acknowledgement.

The CLI waits up to 30 seconds for an operation. A timeout returns `CLI_OPERATION_TIMEOUT` and retires the operation. A later browser result returns `CLI_OPERATION_EXPIRED`.

The state file stores the port, PID, origin, protocol, start time, version, and CLI-private token with mode `0600`. The browser session token stays in companion memory. Clean shutdown removes companion state. A crash leaves detectable stale state, which the next `ppie pair` replaces. Companion restart invalidates the browser session; prompt commands return `CLI_NOT_PAIRED` until pairing succeeds again.

## CORS and private-network preflight

Browser endpoints require an exact allowed `Origin`. Allowed responses include:

```text
Access-Control-Allow-Origin: <exact origin>
Vary: Origin
```

Preflight responses include:

```text
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 600
```

When the request includes `Access-Control-Request-Private-Network: true`, the allowed response includes `Access-Control-Allow-Private-Network: true`. Missing and wrong origins return `CLI_ORIGIN_REJECTED` without CORS allow headers. JSON requests require `Content-Type: application/json`. The body limit is 1 MiB plus 16 KiB for envelope fields.

## Error codes

- `CLI_NOT_PAIRED`, `CLI_INCOMPATIBLE`
- `CLI_INVALID_ORIGIN`, `CLI_ORIGIN_REJECTED`
- `CLI_PAIRING_EXPIRED`, `CLI_PAIRING_REPLAY`, `CLI_PAIRING_REJECTED`
- `CLI_MALFORMED_REQUEST`, `CLI_PAYLOAD_TOO_LARGE`, `CLI_UNAUTHORIZED`
- `CLI_IDEMPOTENCY_CONFLICT`
- `CLI_OPERATION_TIMEOUT`, `CLI_OPERATION_EXPIRED`
- `CLI_INVALID_PROMPT`, `CLI_INVALID_REVISION`, `CLI_REVISION_CONFLICT`
