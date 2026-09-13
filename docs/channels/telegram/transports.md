---
summary: "Long polling and webhook mode compared, with listener and durable ingress behavior"
read_when:
  - Choosing between long polling and webhook mode
  - Putting a reverse proxy in front of the Telegram webhook listener
title: "Telegram transports"
sidebarTitle: "Transports"
---

Long polling is the default. Webhook mode is the alternative when an HTTPS ingress is available.

## Long polling and webhooks

<AccordionGroup>
  <Accordion title="Long polling vs webhook">
    Default is long polling. For webhook mode, set `channels.telegram.webhookUrl` and `channels.telegram.webhookSecret`; optional `webhookPath` (default `/telegram-webhook`), `webhookHost` (default `127.0.0.1`), `webhookPort` (default `8787`), `webhookCertPath` (self-signed cert PEM for direct-IP or no-domain setups).

    The listener reserves `/healthz` for health checks, so `webhookPath` must use a different route. If an existing setup uses `/healthz`, choose another route, update the path in `webhookUrl` and the reverse proxy mapping, then verify that [hot reload](/gateway/configuration/hot-reload) applied the listener change with `openclaw channels status --probe`.

    In long-polling mode, OpenClaw saves its restart position after an update is committed to the durable ingress queue. A failed handler remains retryable from that queue.

    The local listener binds to `127.0.0.1:8787` by default. For public ingress, put a reverse proxy in front of the local port, or set `webhookHost: "0.0.0.0"` intentionally.

    Webhook mode validates request guards, the Telegram secret token, and the JSON body, then commits the update to its durable ingress queue before returning an empty `200`. Successful durable adoption includes `x-openclaw-delivery-accepted: durable`; health, routing, authentication, validation, and storage-error responses omit this header. Reverse proxies and host controllers can require the header to distinguish OpenClaw adoption from a generic empty `200` without inferring acceptance from response timing.

    After the durable write, OpenClaw claims and processes updates through the core channel-ingress drain (per-chat/per-topic lanes, complete at turn adoption, pre-adoption stall timeout). Slow agent turns do not hold Telegram's delivery ACK.

  </Accordion>
</AccordionGroup>

## Ingress ACK boundary

This section lifts the in-code contract into the docs so extension authors stop guessing. It describes the long-polling path; webhook mode shares the same durable spool with a different acknowledgement (see below).

### Order of operations (long polling)

Verified in `extensions/telegram/src/polling-session.ts` (admission block around the "committed spool enqueue is the ACK boundary" comment):

1. Worker receives a Telegram update (`update received`).
2. The update is admitted to the durable ingress queue (`ingressMonitor.admit(update)` → `update spooled`).
3. Only after a successful spool enqueue, the restart offset is persisted (`persistUpdateId(updateId)` → `offset queued`). Offset persistence is monotonic catch-up: a failure is logged (`offset persist failed`) and must not stall intake during a state-store outage.
4. The worker ACKs the spooled update (`ackSpooledUpdate({ ok: true })`), which lets the poller emit the next update. A spool failure ACKs with `ok: false` instead, so a failed admission is not silently acknowledged.
5. Separately, the shared drain claims and processes spooled updates (per-chat/per-topic lanes, complete at turn adoption, pre-adoption stall timeout). Slow plugin hooks and slow agent turns do not hold polling intake.

### What "committed" means here

- The spool is the account-scoped durable ingress queue opened via `state.openChannelIngressQueue()` for `stateDir/telegram/ingress-spool-<account>` (see `resolveTelegramIngressSpoolDir()` in `extensions/telegram/src/telegram-ingress-spool.ts`). The spool-shaped path is used to derive the account and state root; the payloads themselves are rows in the shared `channel_ingress_events` table in `state/openclaw.sqlite` (see `src/channels/message/ingress-queue.ts`), written through the state-store transaction. So the spool inherits the state store's durability — it is not a separate fsync-verified log with its own documented guarantee.
- A healthy drained queue leaves no visible backlog, but that is observed in the queue table, not in the spool directory: the directory can remain empty while a backlog exists, so an empty directory must not be read as "queue drained". A failed handler remains retryable from that queue.
- This page does not promise an fsync, a transaction boundary, or a retention window beyond what the state store provides. If you need a stronger guarantee for your deployment, verify it against the state-store implementation in your release before relying on it.

### What `offset queued` does and does not mean

- `offset queued` means the restart-offset write has been *scheduled*, not committed: `persistUpdateId(updateId)` returns `void | Promise<void>` and the poller logs `offset queued` and ACKs the worker without awaiting it (`extensions/telegram/src/polling-session.ts`, admission block). A failure surfaces later as `offset persist failed` and, per the in-code contract, must not stall intake during a state-store outage.
- Telegram advances the server-side offset only when a subsequent `getUpdates` request carries a higher `offset` (standard Telegram Bot API behavior). Restart initializes from the last *persisted* offset, so a crash between `offset queued` and the actual write can permit Telegram redelivery of an already-spooled update — the drain's idempotency, not the offset, is what stands between that redelivery and double processing.
- If the state directory is ephemeral (wiped container volume, fresh state dir on restart), both the queue table and the saved offset are lost. Updates acknowledged server-side after the last successful poll are then gone from OpenClaw's perspective. Use a persistent state directory when inbound durability matters.

### What this means for extensions

- There is no supported seam to hold acknowledgement until an extension has committed its own record. The intended pattern is: rely on the spool's guarantee and persist from a later hook (`message_received` / `before_dispatch` / `before_agent_run`), accepting the small window between spool commit and your own write.
- Do not run a second poller on the same bot token to work around this. A competing consumer on a shared update queue is worse than the window it tries to close.
- Webhook mode follows the same principle with an HTTP acknowledgement: it validates guards, secret token, and body, commits to the durable queue, then returns an empty `200` with `x-openclaw-delivery-accepted: durable`. Responses without durable adoption (health, routing, auth, validation, storage errors) omit that header so reverse proxies can distinguish adoption from a generic empty `200` without inferring it from timing.
