#!/usr/bin/env node
// The iris-pdf command. Exit codes: 0 done, 1 refused or the review
// failed, 2 verification failed, 3 bad arguments or unreadable input.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { tag, fields, newReport, IrisPdfError, EXIT, VERSION, type TagOptions } from "./index.ts";
import { checkPdfUa } from "./verify/pdfua.ts";
import { review, type Provider } from "./review/review.ts";

const USAGE = `iris-pdf ${VERSION}

iris-pdf tag --pdf <in.pdf> --pages <pages.json> --out <out.pdf>
             [--values <values.json>] [--report <report.json>] [--lang <bcp47>] [--title <text>]
             [--ocr auto|off|required] [--verify pixels,text|off] [--verify-dpi 150]
             [--flatten] [--password <pw>] [--allow-signed] [--partial] [--strict]
iris-pdf fields --pdf <in.pdf> [--json] [--password <pw>]
iris-pdf check --pdf <in.pdf>
iris-pdf review --pdf <tagged.pdf> [--report <review.json>] [--provider anthropic|bedrock] [--model <id>] [--password <pw>]`;

const OPTIONS = {
  pdf: { type: "string" }, pages: { type: "string" }, values: { type: "string" }, out: { type: "string" },
  report: { type: "string" }, lang: { type: "string" }, title: { type: "string" }, ocr: { type: "string" },
  verify: { type: "string" }, "verify-dpi": { type: "string" }, flatten: { type: "boolean" },
  password: { type: "string" }, "allow-signed": { type: "boolean" }, partial: { type: "boolean" },
  strict: { type: "boolean" }, provider: { type: "string" }, model: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
} as const;

function badArgs(message: string): never {
  throw new IrisPdfError("bad_arguments", message, EXIT.badInput);
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return badArgs(`Cannot read ${what} ${path}: ${(e as Error).message}`);
  }
}

function readPdf(path: string | undefined): Uint8Array {
  if (!path) badArgs("--pdf is required.");
  try {
    return readFileSync(path);
  } catch (e) {
    return badArgs(`Cannot read ${path}: ${(e as Error).message}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  let args;
  try {
    args = parseArgs({ args: rest, options: OPTIONS, strict: true }).values;
  } catch (e) {
    return badArgs((e as Error).message);
  }
  if (!command || args.help) {
    console.log(USAGE);
    return command ? 0 : EXIT.badInput;
  }

  if (command === "fields") {
    const list = fields(readPdf(args.pdf), { password: args.password });
    if (args.json) console.log(JSON.stringify(list, null, 2));
    else for (const f of list) console.log(`${f.name}\t${f.type}\tpage ${f.page}${f.options.length ? `\t[${f.options.join(", ")}]` : ""}${f.readonly ? "\treadonly" : ""}${f.required ? "\trequired" : ""}`);
    return 0;
  }

  if (command === "check") {
    const result = checkPdfUa(args.pdf ?? badArgs("--pdf is required."));
    console.log(result.message);
    return result.passed === false ? EXIT.verification : 0;
  }

  if (command === "review") {
    if (args.provider && args.provider !== "anthropic" && args.provider !== "bedrock") badArgs("--provider is anthropic or bedrock.");
    const result = await review(readPdf(args.pdf), { provider: args.provider as Provider, model: args.model, password: args.password });
    for (const { page, findings } of result.pages) for (const f of findings) console.log(`page ${page}\t${f.severity}\t${f.kind}\t${f.element}\t${f.detail}`);
    const n = result.pages.reduce((n, p) => n + p.findings.length, 0);
    const usd = result.estimatedCostUsd === null ? "" : `, about US$${result.estimatedCostUsd.toFixed(4)}`;
    console.error(`${n} finding${n === 1 ? "" : "s"} from ${result.model} (${result.usage.inputTokens} input, ${result.usage.outputTokens} output tokens${usd}).`);
    if (args.report) writeFileSync(args.report, JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  if (command !== "tag") badArgs(`Unknown command "${command}".\n${USAGE}`);
  if (!args.pages || !args.out) badArgs("tag needs --pdf, --pages and --out.");
  const ocr = args.ocr ?? "auto";
  if (!["auto", "off", "required"].includes(ocr)) badArgs("--ocr is auto, off or required.");
  const verify = args.verify ?? "pixels,text";
  if (verify !== "off" && verify !== "pixels,text") badArgs("--verify is pixels,text or off.");
  const dpi = Number(args["verify-dpi"] ?? 150);
  if (!(dpi >= 36 && dpi <= 600)) badArgs("--verify-dpi is between 36 and 600.");

  const opts: TagOptions = {
    values: args.values ? (readJson(args.values, "values") as TagOptions["values"]) : undefined,
    lang: args.lang, title: args.title, ocr: ocr as TagOptions["ocr"],
    verify: verify !== "off", verifyDpi: dpi, flatten: args.flatten, password: args.password,
    allowSigned: args["allow-signed"], partial: args.partial, strict: args.strict,
  };
  const report = newReport();
  const pdf = readPdf(args.pdf);
  const pages = readJson(args.pages, "pages");
  try {
    writeFileSync(args.out, tag(pdf, pages as Parameters<typeof tag>[1], opts, report));
    return 0;
  } catch (e) {
    const err = e instanceof IrisPdfError ? e : new IrisPdfError("internal_error", String((e as Error).message ?? e), EXIT.badInput);
    report.error = { code: err.code, message: err.message };
    throw err;
  } finally {
    if (args.report) writeFileSync(args.report, JSON.stringify(report, null, 2) + "\n");
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof IrisPdfError)) throw e;
  console.error(`iris-pdf: ${e.code}: ${e.message}`);
  process.exitCode = e.exit;
}
