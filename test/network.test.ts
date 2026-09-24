// Tagging never touches the network (spec §3); only the opt-in review does.
// Tag the whole corpus with every way out blocked. This file runs in its own process.
import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { tagFixture } from "./helpers.ts";

const blocked = (() => {
  throw new Error("network use");
}) as never; // assignable to every function it replaces
net.Socket.prototype.connect = blocked;
net.connect = net.createConnection = blocked;
tls.connect = blocked;
dgram.createSocket = blocked;
dns.lookup = dns.resolve = blocked;
http.request = http.get = https.request = https.get = blocked;
globalThis.fetch = blocked;

test("tags every fixture with the network blocked", () => {
  for (const name of ["text-simple", "text-two-column", "links", "form-acroform", "cjk", "blank-page", "mixed", "scan-300dpi"]) {
    assert.ok(tagFixture(name, { partial: true }).out.length, name); // partial: scans pass without Tesseract too
  }
});
