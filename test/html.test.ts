import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPage, isRun, wordsInOrder, type Node } from "../src/html/build.ts";
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

test("lists get a label and a body per item", () => {
  assert.equal(kids("<ol start=3><li>a</li><li>b</li></ol>"),
    'L(LI(Lbl("3."), LBody("a")), LI(Lbl("4."), LBody("b")))');
  assert.equal(kids("<ul><li>a</li></ul>"), 'L(LI(Lbl("•"), LBody("a")))');
  assert.equal(kids("<dl><dt>t</dt><dd>d</dd><dt>u</dt><dd>e</dd></dl>"), 'L(LI(Lbl("t"), LBody("d")), LI(Lbl("u"), LBody("e")))');
  const ol = build("<ol type=a><li>x</li></ol>").top.kids[0] as Node;
  assert.equal(ol.attrs!.ListNumbering, "LowerAlpha");
});

test("images: alt text, decorative and missing", () => {
  const { top, warnings } = build('<img alt="A map"><img alt=""><img src="x.png">');
  assert.deepEqual(top.kids.map((k) => [(k as Node).type, (k as Node).alt]), [["Figure", "A map"]]);
  assert.deepEqual(warnings.map((w) => w.code), ["missing_alt"]);
  assert.equal(kids('<figure><img alt="Chart"><figcaption>Sales</figcaption></figure>'), 'Figure(Caption("Sales"))');
});

test("links and footnotes", () => {
  const { top } = build('<p>See <a href="https://x.org">x</a> and<a href="#n1">1</a></p><p id="n1">Note one</p>');
  assert.equal(top.kids.map(shape).join(", "), 'P("See", Link("x"), "and", Reference(Link("1"))), Note("Note one")');
  assert.equal(((top.kids[0] as Node).kids[1] as Node).href, "https://x.org");
  assert.equal((top.kids[1] as Node).id, "p1-n1");
  // A heading that is a link target stays a heading.
  assert.equal(kids('<p><a href="#fees">Fees</a></p><h2 id="fees">Fees</h2>'), 'P(Reference(Link("Fees"))), H2("Fees")');
});

test("form controls take their label from for=, an enclosing label, or aria-label", () => {
  const { top, warnings } = build(
    '<fieldset><legend>Contact</legend><label for="e">Email</label><input id="e" name="contact" type="radio" value="email"></fieldset>' +
    '<label>Name <input name="name"></label><input name="state" aria-label="State"><input type="hidden" name="h"><input>',
  );
  const forms: Node[] = [];
  const walk = (n: Node) => { if (n.type === "Form") forms.push(n); n.kids.forEach((k) => isRun(k) || walk(k)); };
  walk(top);
  assert.deepEqual(forms.map((f) => f.form), [
    { name: "contact", label: "Email", group: "Contact", value: "email" },
    { name: "name", label: "Name", group: undefined },
    { name: "state", label: "State", group: undefined },
  ]);
  assert.equal((top.kids[0] as Node).title, "Contact");
  assert.deepEqual(warnings.map((w) => w.code), ["field_without_name"]);
});

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
