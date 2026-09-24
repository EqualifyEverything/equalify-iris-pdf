import { test } from "node:test";
import assert from "node:assert/strict";
import { review, tag, type ReviewOptions } from "../src/index.ts";
import { IrisPdfError } from "../src/report.ts";
import { cost, plain, toConverse, fromConverse } from "../src/review/review.ts";
import { pageOutline, headingsBefore } from "../src/review/outline.ts";
import * as mupdf from "mupdf";
import { tagFixture, structTree, readFixture, mcidText } from "./helpers.ts";

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
  assert.equal(r.model, "us.anthropic.claude-sonnet-5");
  assert.deepEqual(r.pages, [{ page: 1, findings: [finding] }]);
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 10 });
  assert.equal(r.estimatedCostUsd, (100 * 2 + 10 * 10) * 1.1 / 1e6);
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

test("no findings after the second ask fails that page, and the others are kept", async () => {
  const { send } = stub(reply([]), { content: [], stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 1 } });
  const r = await review(tagFixture("mixed").out, { send, concurrency: 1 });
  assert.deepEqual(r.pages[0], { page: 1, findings: [] });
  assert.equal(r.pages[1].page, 2);
  assert.match(r.pages[1].error!, /did not report findings for page 2 \(stop reason: end_turn\)/);
  assert.deepEqual(r.usage, { inputTokens: 114, outputTokens: 12 });
});

test("a provider error fails that page; missing credentials fail the run", async () => {
  const failing = (e: Error) => ({ send: async () => { throw e; } });
  const r = await review(tagFixture("text-simple").out, failing(new IrisPdfError("review_failed", "Bedrock: throttled")));
  assert.deepEqual(r.pages, [{ page: 1, findings: [], error: "Bedrock: throttled" }]);
  await assert.rejects(review(tagFixture("text-simple").out, failing(new IrisPdfError("no_credentials", "x"))), { code: "no_credentials" });
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
  assert.match(structure, /^ {2}Link Contents="the city website" href="https:\/\/example\.org\/permits" "the city website"$/m);
  assert.match(structure, /^ {6}TH ID="p1-th1" Scope=Column "Zone"$/m);
  assert.match(structure, /^ {6}TD Headers="p1-th1" "North"$/m);
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
  assert.equal(cost("bedrock", "us.openai.gpt-5.6-luna", usage), 1.848); // AWS's rate, with no Claude uplift
});

test("Bedrock requests go through Converse, the same for every vendor, and come back as Messages replies", async () => {
  const { bodies, send } = stub(reply([]));
  await review(tagFixture("text-simple").out, { provider: "bedrock", model: "us.openai.gpt-5.6-luna", send });
  const input = toConverse({ ...bodies[0], messages: [...bodies[0].messages, { role: "user", content: "Answer." }] }) as any;
  assert.equal(input.modelId, "us.openai.gpt-5.6-luna");
  assert.match(input.system[0].text, /^You review the accessibility/);
  const [image, text] = input.messages[0].content;
  assert.equal(image.image.format, "png");
  assert.equal(Buffer.from(image.image.source.bytes, "base64").subarray(1, 4).toString(), "PNG");
  assert.match(text.text, /^What a screen reader gets/);
  assert.deepEqual(input.messages[1], { role: "user", content: [{ text: "Answer." }] });
  assert.equal(input.toolConfig.tools[0].toolSpec.name, "report_findings");
  assert.deepEqual(input.toolConfig.tools[0].toolSpec.inputSchema.json.required, ["findings"]);
  assert.deepEqual(input.inferenceConfig, { maxTokens: 4096 });

  const finding = { kind: "table", severity: "error", element: "TD", detail: "x" };
  const res = fromConverse({
    output: { message: { content: [{ reasoningContent: {} }, { text: "Found one." }, { toolUse: { toolUseId: "t", name: "report_findings", input: { findings: [finding] } } }] } },
    stopReason: "tool_use", usage: { inputTokens: 900, outputTokens: 40 },
  });
  const r = await review(tagFixture("text-simple").out, { provider: "bedrock", model: "us.openai.gpt-5.6-luna", send: async () => res });
  assert.deepEqual(r.pages, [{ page: 1, findings: [finding] }]);
  assert.deepEqual(r.usage, { inputTokens: 900, outputTokens: 40 });
  assert.deepEqual(fromConverse({ stopReason: "max_tokens" }), { content: [], stop_reason: "max_tokens", usage: { input_tokens: 0, output_tokens: 0 } });
});

test("a text answer is asked again without its tool calls, which would need a tool_result", async () => {
  const other = { content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "t1", name: "other", input: {} }], stop_reason: "tool_use" };
  const { bodies, send } = stub(other, reply([]));
  await review(tagFixture("text-simple").out, { send });
  assert.deepEqual(bodies[1].messages[1].content, [{ type: "text", text: "Checking." }]);
});

test("findings cut off at max_tokens fail the page, without a second ask", async () => {
  const { bodies, send } = stub({ ...reply([]), stop_reason: "max_tokens" });
  const r = await review(tagFixture("text-simple").out, { send });
  assert.match(r.pages[0].error!, /max_tokens/);
  assert.equal(bodies.length, 1);
});

test("over 25 pages is refused before any model call", async () => {
  const { doc } = tagFixture("text-simple");
  for (let i = 0; i < 25; i++) doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, {}, ""));
  const { bodies, send } = stub(reply([]));
  await assert.rejects(review(doc.saveToBuffer("").asUint8Array(), { send }), { code: "too_many_pages" });
  assert.equal(bodies.length, 0);
});

test("a structure tree that points at no content is refused; one with only a figure is reviewed", async () => {
  const { doc } = tagFixture("text-simple");
  doc.getTrailer().get("Root", "StructTreeRoot").put("K", doc.newArray());
  await assert.rejects(review(doc.saveToBuffer("").asUint8Array(), stub(reply([]))), { code: "no_readable_structure" });
  const figure = tag(readFixture("blank-page.pdf"), { pages: [{ sourcePage: 1, html: '<img alt="A bar chart of fees">' }], lang: "en" });
  const { bodies, send } = stub(reply([]));
  await review(figure, { send });
  assert.match(bodies[0].messages[0].content[1].text, /^Figure Alt="A bar chart of fees"$/m);
});

test("the outline says where a link goes: a URI, this document, another action or nowhere", () => {
  const { doc } = tagFixture("structure");
  const root = structTree(doc);
  const link = (s: string | null) => {
    const annot = doc.newDictionary(), act = doc.newDictionary();
    annot.put("Subtype", doc.newName("Link"));
    if (s === "Dest") annot.put("Dest", doc.newArray());
    else if (s) { act.put("S", doc.newName(s)); annot.put("A", act); }
    root.kids[0].objr = [annot];
    return pageOutline(root, 0).split("\n")[0];
  };
  assert.equal(link("GoTo"), 'H1 href=(in this document) "Permit types"');
  assert.equal(link("Dest"), 'H1 href=(in this document) "Permit types"');
  assert.equal(link("Launch"), 'H1 action=Launch "Permit types"');
  assert.equal(link(null), 'H1 href=(none) "Permit types"');
});

test("a root /K array is read", () => {
  const { doc } = tagFixture("text-simple");
  const str = doc.getTrailer().get("Root", "StructTreeRoot");
  const kids = doc.newArray();
  str.get("K").get("K").forEach((k) => { kids.push(k); });
  str.put("K", kids);
  assert.match(pageOutline(structTree(doc), 0), /^P /m);
});

test("a cyclic structure tree is read once; one nested too deep is refused", () => {
  const { doc } = tagFixture("text-simple");
  const top = doc.getTrailer().get("Root", "StructTreeRoot", "K");
  top.get("K").get(0).put("K", top); // a cycle back to the top element
  const root = structTree(doc);
  assert.deepEqual(root.kids[0].kids, []);
  assert.equal(root.kids.length, top.get("K").length);
  let deep = doc.addObject(doc.newDictionary());
  deep.put("S", doc.newName("P"));
  for (let i = 0; i < 70; i++) {
    const up = doc.addObject(doc.newDictionary());
    up.put("S", doc.newName("Div"));
    up.put("K", deep);
    deep = up;
  }
  doc.getTrailer().get("Root", "StructTreeRoot").put("K", deep);
  assert.throws(() => structTree(doc), { code: "bad_structure" });
});

test("/ToUnicode ranges over 256 codes, destinations over 512 bytes and invalid code points are skipped", () => {
  const doc = new mupdf.PDFDocument();
  const cmap = `beginbfrange <0000> <FFFFFFFF> <0041> <0001> <0002> <0041> <0003> <0003> <110000> endbfrange beginbfchar <0004> <D800> <0005> <${"0041".repeat(250_000)}> endbfchar beginbfrange <${"F".repeat(300)}> <${"F".repeat(300)}> <0041> endbfrange`;
  const font = doc.addObject(doc.newDictionary());
  font.put("ToUnicode", doc.addStream(cmap, {}));
  const page = doc.addPage([0, 0, 100, 100], 0, doc.newDictionary(), "<</MCID 0>> BDC /F1 12 Tf <00010002000300040005> Tj EMC");
  page.get("Resources").put("Font", doc.newDictionary()).put("F1", font);
  assert.equal(mcidText(page).get(0), "AB\ufffd\ufffd");
});

test("malformed marked content reads as unknown text; a tree the walk cannot read is unreadable", async () => {
  const doc = new mupdf.PDFDocument();
  const page = doc.addPage([0, 0, 100, 100], 0, doc.newDictionary(), "<</MCID 0>> BDC /F1 12 Tf <0041> Tj EMC");
  const font = doc.newDictionary();
  font.put("Subtype", doc.newName("Type1"));
  page.get("Resources").put("Font", doc.newDictionary()).put("F1", font);
  assert.equal(mcidText(page).get(0), "\ufffd"); // a font with no /ToUnicode
  page.get("Resources").delete("Font");
  assert.equal(mcidText(page).get(0), "\ufffd"); // no /Font resource
  page.put("Contents", doc.newDictionary());
  assert.deepEqual(mcidText(page), new Map()); // /Contents not a stream

  const tagged = tagFixture("text-simple").doc;
  const p = tagged.getTrailer().get("Root", "StructTreeRoot", "K", "K", 0);
  p.delete("Pg");
  p.put("K", 0);
  assert.equal(structTree(tagged).kids[0].text, ""); // no /Pg
  const objr = tagged.newDictionary();
  objr.put("Type", tagged.newName("OBJR"));
  objr.put("Pg", tagged.findPage(0));
  p.put("K", objr); // an OBJR with no /Obj is skipped
  const r = await review(tagged.saveToBuffer("").asUint8Array(), stub(reply([])));
  assert.equal(r.pages[0].error, undefined);
  const kids = tagged.newArray();
  kids.push(tagged.newNull());
  p.put("K", kids);
  await assert.rejects(review(tagged.saveToBuffer("").asUint8Array(), stub(reply([]))), { code: "unreadable" });
});

test("a /ToUnicode CMap over 1 MB is not read", () => {
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject(doc.newDictionary());
  font.put("ToUnicode", doc.addStream(`beginbfchar <0001> <0041> endbfchar${" ".repeat(1 << 20)}`, {}));
  const page = doc.addPage([0, 0, 100, 100], 0, doc.newDictionary(), "<</MCID 0>> BDC /F1 12 Tf <0001> Tj EMC");
  page.get("Resources").put("Font", doc.newDictionary()).put("F1", font);
  assert.equal(mcidText(page).get(0), "\ufffd");
});

test("marked content with no EMC is read in linear time", () => {
  const doc = new mupdf.PDFDocument();
  const page = doc.addPage([0, 0, 100, 100], 0, doc.newDictionary(), "<</MCID 0>> BDC ".repeat(250_000) + "<</MCID 1>> BDC EMC");
  const t = performance.now();
  assert.deepEqual(mcidText(page), new Map([[1, ""]]));
  assert.ok(performance.now() - t < 2000);
});

test("page content is read from the end, each stream once, up to 32 MB a page", () => {
  const doc = new mupdf.PDFDocument();
  const page = doc.addPage([0, 0, 100, 100], 0, doc.newDictionary(), "");
  const big = () => doc.addStream(" ".repeat(20 << 20), {}), mark = (id: number) => doc.addStream(`<</MCID ${id}>> BDC EMC`, {});
  const contents = doc.newArray();
  const big2 = big();
  [mark(0), big(), mark(1), big2, big2, big2, mark(2)].forEach((s) => { contents.push(s); });
  page.put("Contents", contents);
  const t = performance.now();
  assert.deepEqual([...mcidText(page).keys()], [1, 2]); // big2 is read once; the first big would pass 32 MB
  assert.ok(performance.now() - t < 2000);
});

test("a tree whose marked text this tool cannot decode is refused", async () => {
  const { doc } = tagFixture("text-simple");
  const page = doc.findPage(0);
  page.put("Contents", doc.addStream("/P <</MCID 0>> BDC BT /F1 12 Tf (Hello) Tj ET EMC /P <</MCID 1>> BDC EMC", {}));
  await assert.rejects(review(doc.saveToBuffer("").asUint8Array(), stub(reply([]))), { code: "no_readable_structure" });
});

test("an internal link shows its target page, or its named destination", () => {
  const { doc } = tagFixture("mixed");
  const root = structTree(doc), index = new Map([[doc.findPage(1).asIndirect(), 1]]);
  const annot = doc.newDictionary(), act = doc.newDictionary(), d = doc.newArray();
  annot.put("Subtype", doc.newName("Link"));
  act.put("S", doc.newName("GoTo"));
  d.push(doc.findPage(1));
  act.put("D", d);
  annot.put("A", act);
  root.kids[0].objr = [annot];
  assert.match(pageOutline(root, 0, index), /^H1 href=\(page 2\) /);
  act.put("D", doc.newString("fees"));
  assert.match(pageOutline(root, 0, index), /^H1 href=\(in this document, "fees"\) /);
});

test("the outline shows merged table cells", () => {
  const html = '<table><tr><th>Zone</th><th colspan="2">Fees</th></tr><tr><td>North</td><td>10</td><td>20</td></tr></table>';
  const out = tag(readFixture("text-simple.pdf"), { pages: [{ sourcePage: 1, html }], lang: "en" }, { partial: true });
  const outline = pageOutline(structTree(mupdf.PDFDocument.openDocument(out, "application/pdf") as mupdf.PDFDocument), 0);
  assert.match(outline, /^ {6}TH ID="p1-th2" Scope=Column ColSpan=2 "Fees"$/m);
});

test("printed findings have no control characters", () => {
  assert.equal(plain("a\u001b[2Jb\nc\u009bd"), "a [2Jb c d");
});
