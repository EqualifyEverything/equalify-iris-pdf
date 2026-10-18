import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPage, headingShift, isRun, wordsInOrder, type FormRef, type Node } from "../src/html/build.ts";
import type { Warning } from "../src/report.ts";

function build(html: string) {
  const warnings: Warning[] = [];
  return { top: buildPage(html, "en", "p1-", (w) => warnings.push(w)), warnings };
}

// A compact view of a node: "Type(kid, kid)" with runs as their text.
function shape(n: Node | { words: { text: string }[] }): string {
  if (isRun(n as Node)) return JSON.stringify((n as { words: { text: string }[] }).words.map((w) => w.text).join(" "));
  const node = n as Node;
  return node.kids.length ? `${node.type}(${node.kids.map(shape).join(", ")})` : node.type;
}
const kids = (html: string) => build(html).top.kids.map(shape).join(", ");

test("block elements map to PDF structure types", () => {
  assert.equal(kids("<h1>Title</h1><p>Some <em>body</em> text.</p><blockquote>Q</blockquote>"),
    'H1("Title"), P("Some body text."), BlockQuote("Q")');
  assert.equal(kids("loose text"), 'P("loose text")');
  assert.equal(kids("<nav aria-label=Menu><p>x</p></nav>"), 'Sect(P("x"))');
});

test("headings move up together when the document starts below h1", () => {
  const top = buildPage("<h3>Results</h3><h4>Setup</h4><h2>Next</h2>", "en", "p1-", () => {}, 2);
  assert.deepEqual(top.kids.map((k) => (k as Node).type), ["H1", "H2", "H1"]);
  // The first heading of the document, across pages, counting only headings the tree keeps.
  assert.deepEqual(headingShift(["<p>none</p>", "<script><h1>x</h1></script><section><h3>b</h3></section><h4>c</h4>"], "en"),
    { shift: 2, detail: "The first heading is h3; every heading is tagged 2 levels higher, so the first is H1." });
  assert.match(headingShift(["<h2>a</h2>", "<h1>b</h1>"], "en").detail!, /Headings above h2 are all tagged H1\.$/);
  assert.deepEqual(headingShift(["<p>a</p><h1>b</h1><h3>c</h3>"], "en"), { shift: 0 });
});

test("a block's last word is followed by a space, so table cells do not run together", () => {
  const words = wordsInOrder(build("<table><tr><td>Block</td><td><a href=\"#x\">Rate</a></td></tr></table><p>Inputs</p>").top);
  assert.deepEqual(words.map((o) => o.word.space), [true, true, true]);
  const inline = wordsInOrder(build("<p>re<b>use</b>d</p>").top);
  assert.deepEqual(inline.map((o) => o.word.space ?? false), [false, false, true]);
});

test("lists get a label and a body per item", () => {
  assert.equal(kids("<ol start=3><li>a</li><li>b</li></ol>"),
    'L(LI(Lbl("3."), LBody("a")), LI(Lbl("4."), LBody("b")))');
  assert.equal(kids("<ul><li>a</li></ul>"), 'L(LI(Lbl("•"), LBody("a")))');
  assert.equal(kids("<dl><dt>t</dt><dd>d</dd><dt>u</dt><dd>e</dd></dl>"), 'L(LI(Lbl("t"), LBody("d")), LI(Lbl("u"), LBody("e")))');
  assert.equal(kids("<ol type=a><li>a</li><li value=27>b</li></ol>"), 'L(LI(Lbl("a."), LBody("a")), LI(Lbl("aa."), LBody("b")))');
  assert.equal(kids("<ol type=I reversed><li>a</li><li>b</li><li>c</li><li>d</li></ol>"),
    'L(LI(Lbl("IV."), LBody("a")), LI(Lbl("III."), LBody("b")), LI(Lbl("II."), LBody("c")), LI(Lbl("I."), LBody("d")))');
  assert.equal(kids("<ol type=a start=0><li>a</li></ol>"), 'L(LI(Lbl("0."), LBody("a")))');
  const huge = "9".repeat(400);
  assert.equal(kids(`<ol type=a start=${huge}><li value=${huge}>a</li></ol>`), 'L(LI(Lbl("a."), LBody("a")))');
  const ol = build("<ol type=a><li>x</li></ol>").top.kids[0] as Node;
  assert.equal(ol.attrs!.ListNumbering, "LowerAlpha");
});

test("an equation is one Formula, its tokens as words and its MathML spoken as Alt", () => {
  const { top, warnings } = build('<p>So <math alttext="x^2"><msup><mi>x</mi><mn>2</mn></msup></math>.</p>'
    + '<math display="block"><semantics><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><annotation encoding="application/x-tex">a+b</annotation></semantics></math><math></math>');
  assert.deepEqual(warnings, []);
  assert.equal(top.kids.map(shape).join(", "), 'P("So", Formula("x 2"), "."), Formula("a + b")');
  assert.equal(wordsInOrder(top).find((o) => o.word.text === "2")!.word.space ?? false, false);
  // Malformed MathML with no alttext keeps its tokens, and is warned.
  const bad = build("<p>Let <math><msup><mi>x</mi></msup></math> be.</p>");
  assert.equal(bad.top.kids.map(shape).join(", "), 'P("Let", Formula("x"), "be.")');
  assert.deepEqual(bad.warnings, [{ code: "missing_alt", detail: "math: x" }]);
  // An equation with alttext only still has text to own.
  assert.equal(kids('<math alttext="pi"></math>'), 'Formula("pi")');
  const alts: string[] = [];
  const visit = (n: Node) => { if (n.type === "Formula") alts.push(n.alt!); n.kids.forEach((k) => isRun(k) || visit(k)); };
  visit(top);
  assert.deepEqual(alts, ["x squared", "a + b"]);
  // The spoken words are English, so they are marked so in a document that is not.
  const fr = buildPage("<p>Soit <math><mi>x</mi></math></p>", "fr", "p1-", () => {}).kids[0] as Node;
  assert.equal((fr.kids[1] as Node).lang, "en");
  assert.equal((top.kids[1] as Node).lang, undefined);
});

test("images: alt text, decorative and missing", () => {
  const { top, warnings } = build('<img alt="A map"><img alt=""><img src="x.png">');
  assert.deepEqual(top.kids.map((k) => [(k as Node).type, (k as Node).alt]), [["Figure", "A map"]]);
  assert.deepEqual(warnings.map((w) => w.code), ["missing_alt"]);
  // Every <img> is counted, so a figure can be paired with its image on the page.
  const counted = build('<img alt=""><p><img alt="A map"></p>').top;
  assert.deepEqual([((counted.kids[0] as Node).kids[0] as Node).image, counted.images], [1, 2]);
  // A figure is a group: its caption and any table stay content, not hidden behind the image's Alt.
  assert.equal(kids('<figure><img alt="Chart"><figcaption>Sales</figcaption></figure>'), 'Div(Figure, Caption("Sales"))');
  const chart = build("<figure><figcaption>Bars</figcaption><table><tr><td>1</td></tr></table><img src=x></figure>");
  assert.equal(chart.top.kids.map(shape).join(), 'Div(Caption("Bars"), Table(TBody(TR(TD("1")))))');
  assert.deepEqual(chart.warnings.map((w) => w.code), ["missing_alt"]);
});

test("links and footnotes", () => {
  const { top } = build('<p>See <a href="https://x.org">x</a> and<a href="#n1">1</a></p><p id="n1">Note one</p>');
  assert.equal(top.kids.map(shape).join(", "), 'P("See", Link("x"), "and", Reference(Link("1"))), Note("Note one")');
  assert.equal(((top.kids[0] as Node).kids[1] as Node).href, "https://x.org");
  assert.equal((top.kids[1] as Node).id, "p1-n1");
  // A heading that is a link target stays a heading.
  assert.equal(kids('<p><a href="#fees">Fees</a></p><h2 id="fees">Fees</h2>'), 'P(Reference(Link("Fees"))), H2("Fees")');
  // A footnote list item keeps LI > LBody; the Note is inside.
  const list = build('<p>x<a href="#fn-1">1</a></p><ol><li id="fn-1">Source.</li></ol>').top.kids[1] as Node;
  assert.equal(shape(list), 'L(LI(Lbl("1."), LBody(Note("Source."))))');
  assert.equal(((((list.kids[0] as Node).kids[1] as Node).kids[0]) as Node).id, "p1-fn-1");
});

test("form controls take their label from for=, an enclosing label, or aria-label", () => {
  const { top, warnings } = build(
    '<fieldset><legend>Contact</legend><label for="e">Email</label><input id="e" name="contact" type="radio" value="email"></fieldset>' +
    '<label>Name <input name="name"></label><input name="state" aria-label="State"><input type="hidden" name="h"><input>',
  );
  const forms = formsOf(top).map(({ name, label, group, value, type }) => ({ name, label, group, value, type }));
  assert.deepEqual(forms, [
    { name: "contact", label: "Email", group: "Contact", value: "email", type: "radio" },
    { name: "name", label: "Name", group: undefined, value: undefined, type: "text" },
    { name: "state", label: "State", group: undefined, value: undefined, type: "text" },
    { name: "", label: "", group: undefined, value: undefined, type: "text" }, // reported when it is tagged
  ]);
  assert.equal((top.kids[0] as Node).title, "Contact");
  assert.deepEqual(warnings, []);
});

test("form controls keep their label's words, a radio group's question, and a list's options", () => {
  const { top } = build(
    '<p>Do you own a home? <label><input type="radio" name="own" value="y"> Yes</label><label><input type="radio" name="own" value="n"> No</label></p>' +
    '<label for="c">Your city:</label><select id="c" name="city"><option value="a">Ames</option><option>Boone</option></select><textarea name="notes"></textarea>',
  );
  const [yes, no, city, notes] = formsOf(top);
  assert.deepEqual([yes.group, no.group], ["Do you own a home?", "Do you own a home?"]);
  assert.deepEqual(no.labelWords.map((w) => w.text), ["No"]);
  assert.deepEqual(city.labelWords.map((w) => w.text), ["Your", "city:"]);
  assert.deepEqual([city.type, city.options], ["combobox", ["a", "Boone"]]);
  assert.equal(notes.type, "multiline");
});

test("header ids are unique across a page's tables", () => {
  const { top } = build("<table><tr><th>A</th></tr><tr><td>1</td></tr></table><table><tr><th>B</th></tr><tr><td>2</td></tr></table>");
  const ids: string[] = [], walk = (n: Node) => { if (n.id) ids.push(n.id); n.kids.forEach((k) => isRun(k) || walk(k)); };
  walk(top);
  assert.deepEqual(ids, ["p1-th1", "p1-th2"]);
});

function formsOf(top: Node) {
  const forms: FormRef[] = [];
  const walk = (n: Node) => { if (n.form) forms.push(n.form); n.kids.forEach((k) => isRun(k) || walk(k)); };
  walk(top);
  return forms;
}

test("tables: header ids, scope and each cell's headers", () => {
  const { top } = build(
    "<table><thead><tr><th></th><th>Q1</th><th>Q2</th></tr></thead>" +
    "<tbody><tr><th>North</th><td>1</td><td>2</td></tr><tr><th>South</th><td colspan=2>3</td></tr></tbody></table>",
  );
  const cells: Node[] = [];
  const walk = (n: Node) => { if (n.type === "TH" || n.type === "TD") cells.push(n); n.kids.forEach((k) => isRun(k) || walk(k)); };
  walk(top);
  const byText = (t: string) => cells.find((c) => c.kids.some((k) => isRun(k) && k.words[0].text === t))!;
  assert.equal(byText("Q1").id, "p1-th2");
  assert.equal(byText("Q1").attrs!.Scope, "Column");
  assert.equal(byText("North").attrs!.Scope, "Row");
  assert.deepEqual(byText("2").headers, ["p1-th3", "p1-th4"]);
  assert.deepEqual(byText("3").headers, ["p1-th2", "p1-th5"]);
  assert.equal(byText("3").attrs!.ColSpan, 2);
});

test("lang is set only where it changes", () => {
  const { top } = build('<p lang="en">a</p><p lang="fr">b <span lang="fr">c</span></p>');
  assert.deepEqual(top.kids.map((k) => (k as Node).lang), [undefined, "fr"]);
});

test("unknown elements become P and are reported; scripts are dropped", () => {
  const { top, warnings } = build("<marquee>hi</marquee><script>x()</script>");
  assert.equal(top.kids.map(shape).join(), 'P("hi")');
  assert.deepEqual(warnings.map((w) => [w.code, w.detail]), [["unmapped_element", "marquee"]]);
});

test("wordsInOrder numbers top-level blocks", () => {
  const order = wordsInOrder(build("<h1>A b</h1><p>c</p>").top);
  assert.deepEqual(order.map((o) => [o.word.norm, o.block]), [["a", 0], ["b", 0], ["c", 1]]);
});
