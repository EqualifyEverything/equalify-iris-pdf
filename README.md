# equalify-iris-pdf

Use accessible HTML to tag and update a PDF.

[Iris](https://github.com/EqualifyEverything/equalify-iris) turns page images into accessible HTML. This tool takes that HTML and the original PDF, and gives back **the same PDF, tagged**: a structure tree a screen reader can follow, with form fields filled in if you give it values. The page looks exactly as it did.

Tagging runs offline and makes no network or model calls. An optional `review` asks a Claude model to check the result.

## Install

Node 24 or later. Tesseract 5 is optional; it is needed only for scanned pages.

```sh
git clone https://github.com/EqualifyEverything/equalify-iris-pdf && cd equalify-iris-pdf
npm ci
npm test
npm link        # puts iris-pdf on your PATH
```

The sources are TypeScript, run directly by Node. Node does not do that inside `node_modules`, so use a clone (as above), not `npm install` from another project.

## Use

```sh
iris-pdf tag --pdf in.pdf --pages pages.json --out out.pdf --report report.json
iris-pdf fields --pdf in.pdf [--json]
iris-pdf check --pdf out.pdf          # runs veraPDF's PDF/UA-1 check, if installed
iris-pdf review --pdf out.pdf [--report review.json]   # optional AI review, below
```

`tag` options:

| Option | Meaning |
|---|---|
| `--values values.json` | Fill form fields (below). |
| `--lang`, `--title` | Used when `pages.json` has none. A language is required. |
| `--ocr auto\|off\|required` | Use Tesseract for pages with no text layer. Default `auto`. |
| `--verify pixels,text\|off` | The checks below. On by default. `--verify-dpi` sets the render resolution (36–600, default 150). |
| `--flatten` | Draw the field values into the page and remove the fields. |
| `--password` | Open an encrypted PDF. The output keeps its encryption. |
| `--allow-signed` | Tag a signed PDF. This breaks the signature, and the report says so. |
| `--partial` | Leave a page untagged, instead of failing, when it has no way to place text. |
| `--strict` | Fail on any warning that means content went untagged or unmatched, or that the file was `repaired`. |

### pages.json

Iris's HTML, one entry per source page:

```json
{ "lang": "en", "title": "Parking permit",
  "pages": [{ "sourcePage": 1, "html": "<h1>Parking Permit</h1><p>…</p>" }] }
```

### values.json

Field name to value. Names are the ones `iris-pdf fields` prints.

```json
{ "applicant.name": "Ada Lovelace", "applicant.consent": true, "contact": "phone", "state": "WI" }
```

Text fields take strings, checkboxes `true`/`false`, radio groups and lists one of their options. A wrong type, an unknown option or a value over the field's length limit stops the run before anything is written. Read-only fields are skipped and counted. Unchecking always writes `/Off`, whatever the source used for "off".

## How it works

1. The page's original drawing is kept byte for byte and marked as an artifact.
2. Iris's words are matched to the words on the page (from the text layer, or from Tesseract on a scan).
3. An invisible text layer is added with Iris's words at those positions, tagged with the structure from the HTML: headings, lists, tables with their headers, links, figures with alt text, form fields.
4. The file is saved incrementally: the original bytes are the start of the output. A damaged file is instead rewritten from mupdf's repair of it, with warning `repaired`.

Then two checks run, and if either fails nothing is written (exit 2):

- **Pixels.** Every page renders the same as before, except inside fields whose values changed.
- **Text.** Every word the source had is still there, and every character of the added layer can be read back.

## The report

`--report` writes JSON: per page, where the text came from and how many words matched; the structure written; fields set and skipped; the check results; and every warning. Warnings name what could not be done, for example `unmatched_text` (page text missing from the HTML, kept as a paragraph), `missing_alt`, `field_not_in_html`, `unmatched_link`, `duplicate_text_layer`, `page_not_in_html` and `page_not_tagged` (the page is left as it was; a blank page needs no HTML and is not warned), `no_title`, `font_not_embedded` (a source font has no embedded program, which PDF/UA-1 requires; the source drawing is not changed), `source_marked_content` (the page drawing has marked-content ids left from an earlier tag tree), `alignment_incomplete` (the page and the HTML differ too much to match every word in time; the rest is kept as unmatched text).

## Review

`review` checks what `check` cannot: whether the tags say what the page says. For each page it sends a Claude model the page image and what a screen reader gets from the page: the structure, text, alt text, link targets and field names. It reports missing content, wrong reading order, wrong element types or heading levels, tables, alt text, link text, field names and language. It prints one finding per line, writes them to `--report` as JSON with the tokens used and an estimated cost, and exits 0. Nothing in the PDF is changed.

**It sends page images and text to the model provider.** With `ANTHROPIC_API_KEY` set, it uses the Anthropic API. Otherwise it uses Amazon Bedrock through the AWS CLI, with your AWS credentials and region. Choose with `--provider anthropic|bedrock` and `--model <id>`. The default model is Opus 5.5, at about US$0.03 a page. See [docs/models.md](docs/models.md) for the models compared and their costs.

## PDF/UA

The output declares PDF/UA-1 only when it has a title, every page is tagged, every source font is embedded, and no page drawing has leftover marked content. The tests check each such claim with veraPDF.

## Refusals and exit codes

| Exit | When |
|---|---|
| 0 | Done. |
| 1 | Refused: `encrypted` (no or wrong password), `permissions_denied`, `too_many_pages` (over 25), `too_many_words` (over 4000 on a page), `already_tagged`, `xfa` (dynamic form), `signed`, `no_acroform_field`, `no_text_positions`, `strict`. From `review`: `review_failed` (the model or its API failed). |
| 2 | A check failed: `pixels_changed`, `text_lost`. |
| 3 | Bad input: `unreadable`, `bad_pages`, `no_document_language`, `bad_value`, `field_not_settable`, `bad_arguments`. From `review`: `not_tagged`, `no_credentials`. |

Errors print one line: `iris-pdf: <code>: <message>`.

## Privacy

Form values are personal data. They are never printed, logged, or put in the report or an error message; only field names are. `review` sends page images, which show any filled-in values, to the model provider.

## Known limits

- **The text exists twice** on a page that already had a text layer: the original, now an artifact, and ours. Screen readers use ours. Plain copy-and-paste tools may show the text doubled. The report warns `duplicate_text_layer`.
- A table that continues onto the next page is tagged as two tables.
- `check` needs veraPDF installed.
- `review` reads only structure tagged by this tool. Its findings are a model's judgment: check them before acting on them.
- A form with no fields (a flat form) cannot be filled.

## License

[AGPL-3.0-or-later](LICENSE).
