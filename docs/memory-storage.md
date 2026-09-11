# Durable archive and character memory bridge

Every accepted create/edit event is serialized with native author ID and edit timestamp to `.state/archive-outbox` before Supabase/R2 work. One systemd process owns the queue. A batch drains at most 25 entries; errors retain the batch for the 30-second retry. Removal follows successful message persistence. Corrupt JSON stops that batch and remains for diagnosis. Local disk failure before durable enqueue cannot be recovered by this queue.

An R2 upload failure keeps the Discord CDN URL in the message and durably queues its identifiers in `.state/attachment-outbox`. The same process retries every 30 seconds; after upload it replaces only the exact filename/source URL pair in Supabase. A missing initial message or DB failure retains the job. The queue does not delete source messages or existing memory.

Native Discord deletion intentionally does not delete archived messages or R2 objects.

`DISCORD_CHARACTER_MEMORY_INGEST=true` switches the final save to `memory_ingest_discord_message_v1` only after migration acceptance. Without the flag, existing archive upsert remains active. DB errors, including unique violations, are not acknowledged as success. `DISCORD_CHARACTER_MEMORY_POLICY_FILE` optionally enables five-minute permission renewal from a deployed core contract; leases last nine minutes. Failed Discord permission checks remove its scopes; a missing publisher causes leases to expire. No new X requests are made.

Validation: TypeScript build and seven network-isolated tests for retry, restart, concurrency, corruption, native author/edit metadata, DB errors and scope leases. Run `node --test test/*.test.mjs` after building. Do not start a second logger process to test this.
