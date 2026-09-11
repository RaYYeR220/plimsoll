import assert from "node:assert/strict";
import { test } from "node:test";
import { agentCard, handleA2a } from "../src/a2a.js";
import { deps, loadedFrom, loadRecording, testConfig } from "./helpers.js";

const config = testConfig({ publicBaseUrl: "https://mcp.example" });
const d = deps({ feeds: new Map(), now: Date.now(), loaded: loadedFrom(loadRecording("mainnet")), config });

test("agent card carries every field A2A v1.0 requires", () => {
  const card = agentCard(config) as Record<string, any>;
  for (const k of ["name", "description", "version", "supportedInterfaces", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"]) {
    assert.ok(card[k] !== undefined && card[k] !== "", `missing ${k}`);
  }
  const iface = card.supportedInterfaces[0];
  assert.equal(iface.url, "https://mcp.example/a2a/v1");
  assert.equal(iface.protocolBinding, "JSONRPC");
  assert.equal(iface.protocolVersion, "1.0");
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.equal("url" in card, false, "v0.x top-level url must not appear in a v1.0 card");
  assert.ok(card.skills.length >= 4);
  for (const s of card.skills) {
    for (const k of ["id", "name", "description"]) assert.equal(typeof s[k], "string", `skill ${s.id} ${k}`);
    assert.ok(Array.isArray(s.tags) && s.tags.length > 0, `skill ${s.id} tags`);
  }
});

test("SendMessage with a DataPart runs the skill and answers with a Message", async () => {
  const res = (await handleA2a(d, {
    jsonrpc: "2.0",
    id: 7,
    method: "SendMessage",
    params: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ data: { skill: "feed-status", args: {} } }] } },
  })) as Record<string, any>;
  assert.equal(res.id, 7);
  const msg = res.result.message;
  assert.equal(msg.role, "ROLE_AGENT");
  assert.equal(msg.parts[0].mediaType, "application/json");
  assert.equal(msg.parts[0].data.result, "status");
});

test("v0.3 message/send is accepted for older clients", async () => {
  const res = (await handleA2a(d, {
    jsonrpc: "2.0",
    id: "x",
    method: "message/send",
    params: { message: { messageId: "m2", role: "user", parts: [{ kind: "data", data: { skill: "vault_backing", args: { network: "mainnet", vault: "0x9d39a5de30e57443bff2a8307a4256c8797a3497" } } }] } },
  })) as Record<string, any>;
  assert.equal(res.result.kind, "message");
  assert.equal(res.result.parts[0].data.result, "refused");
  assert.equal(res.result.parts[0].data.reason, "source_unavailable");
});

test("unsupported methods and malformed calls are JSON-RPC errors, not silent", async () => {
  const a = (await handleA2a(d, { jsonrpc: "2.0", id: 1, method: "GetTask", params: {} })) as Record<string, any>;
  assert.equal(a.error.code, -32601);
  const b = (await handleA2a(d, { jsonrpc: "2.0", id: 2, method: "SendMessage", params: { message: { parts: [{ text: "hello" }] } } })) as Record<string, any>;
  assert.equal(b.error.code, -32602);
  const c = (await handleA2a(d, { jsonrpc: "2.0", id: 3, method: "SendMessage", params: { message: { parts: [{ data: { skill: "vault-backing", args: { network: "mainnet", vault: "bad" } } }] } } })) as Record<string, any>;
  assert.equal(c.error.code, -32602);
});
