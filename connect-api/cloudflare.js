"use strict";

const { randomBytes } = require("node:crypto");
const { fetchJSON } = require("../electron/cloud/http");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[a-f0-9]{32}$/;

function createCloudflare({ token, accountId, zoneId, domain, fetch = globalThis.fetch }) {
  if (!token || !ID.test(accountId) || !ID.test(zoneId) || typeof domain !== "string" ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error("Invalid Cloudflare configuration.");
  const base = `accounts/${accountId}/cfd_tunnel`;
  async function api(path, method = "GET", body) {
    let data;
    try { data = await fetchJSON(fetch, `https://api.cloudflare.com/client/v4/${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }); } catch (error) {
      if (method === "DELETE" && error.remoteStatus === 404) return null;
      throw new Error("Cloudflare request failed.");
    }
    if (data.success !== true) throw new Error("Cloudflare request failed.");
    return data.result;
  }
  return {
    async prepare(row) {
      if (!UUID.test(row.linkId) || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535) throw new Error("Invalid host port or link.");
      const name = `solenta-${row.linkId}`;
      const hostname = `c-${row.linkId}.${domain}`;
      const allocation = row.allocation;
      allocation.hostname = hostname;
      if (!allocation.tunnelId) {
        const matches = await api(`${base}?name=${name}&is_deleted=false`);
        if (!Array.isArray(matches) || matches.length > 1 || (matches[0] && matches[0].name !== name)) throw new Error("Cloudflare tunnel identity mismatch.");
        const tunnel = matches[0] ?? await api(base, "POST", { name, config_src: "cloudflare", tunnel_secret: randomBytes(32).toString("base64") });
        if (!UUID.test(tunnel?.id)) throw new Error("Invalid Cloudflare tunnel identity.");
        allocation.tunnelId = tunnel.id;
      }
      await api(`${base}/${allocation.tunnelId}/configurations`, "PUT", { config: { ingress: [
        { hostname, service: `http://127.0.0.1:${row.port}` }, { service: "http_status:404" },
      ] } });
      if (!allocation.dnsId) {
        const matches = await api(`zones/${zoneId}/dns_records?type=CNAME&name=${hostname}`);
        const content = `${allocation.tunnelId}.cfargotunnel.com`;
        if (!Array.isArray(matches) || matches.length > 1 || (matches[0] && (matches[0].name !== hostname || matches[0].content !== content || matches[0].proxied !== true))) throw new Error("Cloudflare DNS identity mismatch.");
        const record = matches[0] ?? await api(`zones/${zoneId}/dns_records`, "POST", { type: "CNAME", name: hostname, content, proxied: true, ttl: 1 });
        if (!ID.test(record?.id)) throw new Error("Invalid Cloudflare DNS identity.");
        allocation.dnsId = record.id;
      }
      const connectorToken = await api(`${base}/${allocation.tunnelId}/token`);
      if (typeof connectorToken !== "string" || !connectorToken || connectorToken.length > 16384) throw new Error("Invalid Cloudflare connector credential.");
      return connectorToken;
    },
    async remove(row) {
      const { dnsId, tunnelId } = row.allocation;
      if (dnsId) {
        if (!ID.test(dnsId)) throw new Error("Invalid Cloudflare DNS identity.");
        await api(`zones/${zoneId}/dns_records/${dnsId}`, "DELETE");
      }
      if (tunnelId) {
        if (!UUID.test(tunnelId)) throw new Error("Invalid Cloudflare tunnel identity.");
        await api(`${base}/${tunnelId}`, "DELETE");
      }
    },
  };
}

module.exports = { createCloudflare };
