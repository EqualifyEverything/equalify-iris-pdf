import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml, type Elem } from "../src/html/parse.ts";
import { speak } from "../src/html/math.ts";

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
  // The TeX annotation is the HTML's fallback, not what is read.
  assert.equal(say('<semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics>'), "x");
});
