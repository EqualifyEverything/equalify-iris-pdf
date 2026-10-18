import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml, type Elem } from "../src/html/parse.ts";
import { mathml, speak } from "../src/html/math.ts";

const say = (mathml: string) => speak(parseHtml(`<math>${mathml}</math>`).kids[0] as Elem);

test("MathML is spoken as words, its layout included", () => {
  assert.equal(say("<msup><mi>x</mi><mn>2</mn></msup>"), "x squared");
  assert.equal(say("<msup><mi>e</mi><mrow><mi>i</mi><mi>π</mi></mrow></msup>"), "e to the power i π end power");
  assert.equal(say("<msup><mi>f</mi><mo>′</mo></msup>"), "f prime");
  assert.equal(say("<mfrac><mi>a</mi><mi>b</mi></mfrac>"), "a over b");
  assert.equal(say("<mfrac><mrow><mi>a</mi><mo>+</mo><mn>1</mn></mrow><mi>b</mi></mfrac>"), "fraction a + 1 over b end fraction");
  assert.equal(say("<msqrt><mi>x</mi></msqrt>"), "square root of x end root");
  assert.equal(say("<mroot><mi>x</mi><mn>3</mn></mroot>"), "root with index 3 of x end root");
  assert.equal(say("<msubsup><mi>M</mi><mn>2</mn><mi>G</mi></msubsup>"), "M sub 2 to the power G");
  assert.equal(say("<munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover>"), "∑ from i = 1 to n");
  assert.equal(say("<mover><mi>x</mi><mo>^</mo></mover>"), "x hat");
  assert.equal(say("<mi>f</mi><mo>⁡</mo><mo>(</mo><mi>x</mi><mo>)</mo>"), "f ( x )");
  assert.equal(say("<mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>0</mn></mtd></mtr><mtr><mtd><mn>0</mn></mtd><mtd><mn>1</mn></mtd></mtr></mtable>"),
    "table row 1 1, 0, row 2 0, 1 end table");
  assert.equal(say("<mover><mi>x</mi><mi>constructor</mi></mover>"), "x over constructor");
  // Malformed MathML is not guessed at: the Formula falls back to alttext.
  assert.equal(say("<msup><mi>x</mi></msup>"), "");
  assert.equal(say("<mrow><mfrac><mi>a</mi>b</mfrac></mrow>"), "");
  // The TeX annotation is the HTML's fallback, not what is read.
  assert.equal(say('<semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics>'), "x");
});

test("deeply nested MathML is spoken in linear time", () => {
  const start = Date.now();
  assert.equal(say("<mrow>".repeat(200) + "<mi>x</mi>" + "</mrow>".repeat(200)), "x");
  assert.ok(Date.now() - start < 1000);
});

test("MathML is written back as XML in the MathML namespace, escaped", () => {
  const e = parseHtml('<math display="block"><mi>a</mi><mo>&lt;</mo><mtext>"b" &amp; c</mtext></math>').kids[0] as Elem;
  assert.equal(mathml(e), '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mi>a</mi><mo>&lt;</mo><mtext>&quot;b&quot; &amp; c</mtext></math>');
  // Malformed HTML still gives well-formed XML.
  const bad = parseHtml('<math a"b=1 xmlns="x"><mtext>]]>&#1;</mtext><mi"x>y</mi"x></math>').kids[0] as Elem;
  assert.equal(mathml(bad), '<math xmlns="http://www.w3.org/1998/Math/MathML"><mtext>]]&gt;</mtext>y</math>');
});
