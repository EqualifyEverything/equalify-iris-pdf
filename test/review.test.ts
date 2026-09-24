import { test } from "node:test";
import assert from "node:assert/strict";
import { review, type ReviewOptions } from "../src/index.ts";
import { cost } from "../src/review/review.ts";
import { pageOutline, headingsBefore } from "../src/review/outline.ts";
import { tagFixture, structTree, readFixture } from "./helpers.ts";

type Body = { model: string; tools: { name: string }[]; tool_choice?: unknown; messages: { role: string; content: any }[] };

const reply = (findings: unknown[], usage = { input_tokens: 100, output_tokens: 10 }) =>
  ({ content: [{ type: "tool_use", name: "report_findings", input: { findings } }], stop_reason: "tool_use", usage });

function stub(...replies: unknown[]) {
  const bodies: Body[] = [];
  const send: ReviewOptions["send"] = async (body) => { bodies.push(body as Body); return replies[Math.min(bodies.length - 1, replies.length - 1)]; };
  return { bodies, send };
}

test("sends each page's image and screen-reader view, and reads back the findings", async () => {
  const { out } = tagFixture("structure");
  const finding = { kind: "alt_text", severity: "error", element: 'Figure Alt="…"', detail: "No image is on the page." };
  const { bodies, send } = stub(reply([finding]));
  const r = await review(out, { provider: "bedrock", send });
  assert.equal(bodies.length, 1);
  const [image, text] = bodies[0].messages[0].content;
  assert.equal(image.source.media_type, "image/png");
  assert.equal(Buffer.from(image.source.data, "base64").subarray(1, 4).toString(), "PNG");
  assert.match(text.text, /Document language: en\. Title: "Test document"\./);
  assert.match(text.text, /^H1 "Permit types"$/m);
  assert.match(text.text, /^  Figure Alt="Zones north and south of the river"$/m);
  assert.deepEqual(bodies[0].tools.map((t) => t.name), ["report_findings"]);
  assert.equal(bodies[0].tool_choice, undefined); // Opus 5.5 rejects a forced tool
  assert.equal(r.model, "us.anthropic.claude-opus-5-5");
  assert.deepEqual(r.pages, [{ page: 1, findings: [finding] }]);
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 10 });
  assert.equal(r.estimatedCostUsd, (100 * 4 + 10 * 20) * 1.1 / 1e6);
});

test("an unknown kind or severity is kept, as other and warning", async () => {
  const { send } = stub(reply([{ kind: "colour", severity: "fatal", element: "P", detail: "x" }]));
  const r = await review(tagFixture("text-simple").out, { send });
  assert.deepEqual(r.pages[0].findings, [{ kind: "other", severity: "warning", element: "P", detail: "x" }]);
});

test("a model that answers in text is asked once more to call the tool", async () => {
  const text = { content: [{ type: "text", text: "Looks fine." }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 5 } };
  const { bodies, send } = stub(text, reply([]));
  const r = await review(tagFixture("text-simple").out, { send });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].messages.slice(1).map((m) => m.role), ["assistant", "user"]);
  assert.deepEqual(r.pages, [{ page: 1, findings: [] }]);
  assert.deepEqual(r.usage, { inputTokens: 150, outputTokens: 15 });
});

test("no findings after the second ask fails the review", async () => {
  const { send } = stub({ content: [], stop_reason: "end_turn" });
  await assert.rejects(review(tagFixture("text-simple").out, { send }), { code: "review_failed" });
});

test("an untagged PDF is refused", async () => {
  await assert.rejects(review(readFixture("text-simple.pdf"), stub(reply([]))), { code: "not_tagged" });
});

test("the anthropic provider needs ANTHROPIC_API_KEY", async () => {
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(review(tagFixture("text-simple").out, { provider: "anthropic" }), { code: "no_credentials" });
  } finally {
    if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
  }
});

test("each page is reviewed with its own outline and the headings before it", async () => {
  const { bodies, send } = stub(reply([]));
  const r = await review(tagFixture("mixed").out, { send, concurrency: 1 });
  assert.deepEqual(r.pages.map((p) => p.page), [1, 2]);
  const second = bodies[1].messages[0].content[1].text;
  assert.match(second, /Headings on earlier pages:\nH1 "Parking Permit"\nH2 "Fees"/);
  assert.match(second, /This page:\nH2 "Office Address"\nP "The permit office is on Main Street\."$/);
});

test("the outline shows links, table headers and form fields as a screen reader reads them", () => {
  const structure = pageOutline(structTree(tagFixture("structure").doc), 0);
  assert.match(structure, /^ {2}Link href="https:\/\/example\.org\/permits" "the city website"$/m);
  assert.match(structure, /^ {6}TH Scope=Column "Zone"$/m);
  const form = pageOutline(structTree(tagFixture("form-acroform").doc), 0);
  assert.match(form, /^ {2}Form Alt="Full name" field=Tx name="Full name"$/m);
  assert.match(form, /^Form field=Btn name="reset"$/m); // the reset button is not in the HTML
});

test("long text is cut, and says so", () => {
  const { doc } = tagFixture("text-simple");
  const root = structTree(doc);
  root.kids[1].parts = ["x".repeat(2010)];
  assert.match(pageOutline(root, 0), /^P "x{2000}" \[10 more characters not shown\]$/m);
  assert.deepEqual(headingsBefore(root, 0), []);
});

test("cost: list prices, 10% more on Bedrock regional profiles, null when unknown", () => {
  const usage = { inputTokens: 1e6, outputTokens: 1e6 };
  assert.equal(cost("anthropic", "claude-opus-5-5", usage), 24);
  assert.equal(cost("anthropic", "claude-opus-5", usage), 30);
  assert.equal(cost("bedrock", "us.anthropic.claude-sonnet-5", usage), 13.2);
  assert.equal(cost("bedrock", "global.anthropic.claude-haiku-4-5-20251001-v1:0", usage), 6);
  assert.equal(cost("anthropic", "some-other-model", usage), null);
});
