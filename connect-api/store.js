"use strict";

const { randomUUID } = require("node:crypto");

function conflict(message) { return Object.assign(new Error(message), { status: 409 }); }

function createStore(pool) {
  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '15s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  async function save(client, row) {
    await client.query(`INSERT INTO cloud_computers (computer_id, owner_id, data) VALUES ($1,$2,$3)
      ON CONFLICT (computer_id) DO UPDATE SET owner_id=$2, data=$3`, [row.computerId, row.accountId, row]);
  }
  return {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS cloud_computers (
        computer_id text PRIMARY KEY, owner_id text NOT NULL, data jsonb NOT NULL);
        CREATE INDEX IF NOT EXISTS cloud_computers_owner ON cloud_computers(owner_id)`);
    },
    async list(accountId) {
      const { rows } = await pool.query("SELECT data FROM cloud_computers WHERE owner_id=$1 AND data->>'revoked'='false' ORDER BY computer_id", [accountId]);
      return rows.map(row => row.data);
    },
    async getHost(computerId) {
      return (await pool.query("SELECT data FROM cloud_computers WHERE computer_id=$1", [computerId])).rows[0]?.data ?? null;
    },
    async register(accountId, input, maxComputers) {
      return transaction(async client => {
        // Account locking makes the quota apply even to simultaneous different computers.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`account:${accountId}`]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`computer:${input.computerId}`]);
        const existing = (await client.query("SELECT data FROM cloud_computers WHERE computer_id=$1 FOR UPDATE", [input.computerId])).rows[0]?.data;
        if (existing && (existing.accountId !== accountId || existing.keyThumbprint !== input.keyThumbprint)) throw conflict("Computer already belongs to another account or host key.");
        const registrationNonces = (existing?.registrationNonces ?? []).filter(entry => entry.expiresAt > Date.now());
        if (existing?.revoked && registrationNonces.some(entry => entry.nonce === input.nonce)) throw conflict("Start a new link request after unlinking.");
        if (!registrationNonces.some(entry => entry.nonce === input.nonce)) registrationNonces.push({ nonce: input.nonce, expiresAt: input.proofExpiresAt });
        if (existing && !existing.revoked) {
          existing.label = input.label;
          existing.port = input.port;
          existing.registrationNonces = registrationNonces;
          await save(client, existing);
          return existing;
        }
        const count = (await client.query("SELECT count(*) FROM cloud_computers WHERE owner_id=$1 AND data->>'revoked'='false'", [accountId])).rows[0].count;
        if (Number(count) >= maxComputers) throw conflict("This account has reached its computer limit.");
        const outstanding = (await client.query(`SELECT COALESCE(sum(
          CASE WHEN data->>'revoked'='false' THEN 1 ELSE 0 END +
          CASE WHEN data ? 'cleanupPending' THEN 1 ELSE 0 END +
          jsonb_array_length(COALESCE(data->'retired','[]'::jsonb))),0) AS count FROM cloud_computers WHERE owner_id=$1`, [accountId])).rows[0].count;
        if (Number(outstanding) >= maxComputers * 2) throw conflict("Finish pending cloud cleanup before linking another computer.");
        const row = { computerId: input.computerId, accountId, publicKey: input.publicKey, keyThumbprint: input.keyThumbprint,
          label: input.label, port: input.port, linkId: randomUUID(), generation: (existing?.generation ?? 0) + 1,
          registrationNonces, revoked: false, status: "pending", allocation: {}, lastSeen: null,
          retired: [...(existing?.retired ?? []), ...(existing?.cleanupPending ? [existing.cleanupPending] : [])] };
        await save(client, row);
        return row;
      });
    },
    async updateIfLink(computerId, linkId, work) {
      return transaction(async client => {
        const row = (await client.query("SELECT data FROM cloud_computers WHERE computer_id=$1 FOR UPDATE", [computerId])).rows[0]?.data;
        if (!row || row.linkId !== linkId) return null;
        const result = await work(row);
        await save(client, row);
        return result;
      });
    },
  };
}

module.exports = { createStore };
