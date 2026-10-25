# equalify-iris-pdf

Use accessible HTML to tag and update a PDF.

[Iris](https://github.com/EqualifyEverything/equalify-iris) turns page images into accessible HTML. This tool takes that HTML and the original PDF, and gives back **the same PDF, tagged**: a structure tree a screen reader can follow, with form fields filled in if you give it values. The page looks exactly as it did.

Tagging runs offline and makes no network or model calls. An optional `review` asks a model to check the result.

## Install

Node 24 or later. Tesseract 5 is optional. It places a scan's text over its image; without it, a scan is still tagged, its text placed approximately.

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
| `--flatten` | Draw the field values into the page and remove the fields. |
| `--password` | Open an encrypted PDF. The output keeps its encryption. |
| `--allow-signed` | Tag a signed PDF. This breaks the signature, and the report says so. |
| `--report-detail` | Add `detail` to the report: where and why, below. |

### pages.json

Iris's HTML, one entry per source page:

```json
{ "lang": "en", "title": "Parking permit",
  "pages": [{ "sourcePage": 1, "html": "<h1>Parking Permit</h1><p>…</p>" }] }
```

### values.json

Field name to value. Names are the ones `iris-pdf fields` prints; with `--json`, each field's `label` is its tooltip (`/TU`, trimmed), or `null`.

```json
{ "applicant.name": "Ada Lovelace", "applicant.consent": true, "contact": "phone", "state": "WI" }
```

Text fields take strings, checkboxes `true`/`false`, radio groups and lists one of their options. A wrong type, an unknown option or a value over the field's length limit stops the run before anything is written. Read-only fields are skipped and counted. Unchecking always writes `/Off`, whatever the source used for "off".

### Flat forms

A PDF with no form fields, such as a scanned form, gets them from the HTML: each `<input>`, `<select>` and `<textarea>` becomes a field on the blank beside its label (an underline, a box, a table cell, a check box or radio circle). A field is named by its `name`, else its `id`, else its label, with periods made dashes and a number added to a repeat (`date-2`). The report lists the names under `form.created`, and `--values` fills them by those names. A control whose blank is not found is warned `field_not_placed` and gets no field; its label is still read. A scan needs Tesseract for this: with its words placed approximately, no fields are made.

## How it works

1. The page's original drawing is kept and marked as an artifact, except each image a figure shows, which is marked as that figure's content, and the page's own text (step 3). Its drawing does not change, but marked content left from old tags is removed from it. A PDF that is already tagged loses its old tags first (warning `retagged`); each retag adds to the file's size.
2. Iris's words are matched to the words on the page (from the text layer, or from Tesseract on a scan). Several of Iris's words can match one page word that runs them together, as math often does (`2x` for `2` `x`). With neither, the words flow down the page in reading order.
3. The page's own text is tagged where it is, a show operator split where its words belong to different elements. A word the page spells differently, such as one hyphenated across lines, reads as Iris's (ActualText). Iris's words that the page does not draw, or draws in a way this tool cannot read code by code (inside a form XObject, say), go in an added invisible text layer at their positions. If the page's own text, so tagged, fails the checks below, the whole document is tagged from the added layer instead (warning `in_place_failed`). Both are tagged with the structure from the HTML: headings (moved up together if the first is not h1, as PDF/UA-1 requires; warning `headings_shifted`), lists (each item labelled as a browser numbers it, from `type`, `start`, `value` and `reversed`), tables with their headers, links, figures with alt text, equations (each `<math>` is a `Formula`, its Alt spoken from the MathML, such as "x squared"; `alttext`, often TeX, is only the fallback; the MathML itself is attached as an associated file, for readers that speak math), form fields.
4. The file is saved incrementally: the original bytes are the start of the output. A damaged file is instead rewritten from mupdf's repair of it, with warning `repaired`.

Then two checks run, and if either fails nothing is written (exit 2):

- **Pixels.** Every page renders the same as before, except inside fields whose values changed.
- **Text.** Every word the source had is still there, and every character of the added layer can be read back.

## The report

A page that could not be tagged is left untagged, with a warning, and the run still exits 0. Its drawing renders as before, but if the HTML had the page, old marked content is removed from it. Read the report to catch it; the output then makes no PDF/UA-1 claim.

`--report` writes JSON: per page, where the text came from and how many words matched; the structure written; fields set and skipped; the check results; and every warning. Warnings name what could not be done, for example `unmatched_text` (page text missing from the HTML, kept as a paragraph), `missing_alt`, `field_not_in_html`, `unmatched_link`, `duplicate_text_layer` (words drawn again in the added layer, so plain extractors may show them twice), `in_place_failed`, `page_not_in_html` (a blank page needs no HTML and is not warned), `page_not_tagged`, `no_text_positions` (a scan, with Tesseract missing or failing: tagged, but its text does not line up with its image), `no_title`, `field_not_placed` (a flat form's control with no blank found for it), `font_not_embedded` (a source font has no embedded program, which PDF/UA-1 requires; the source drawing is not changed), `source_marked_content` (a page not in the HTML, or a form XObject, pattern or annotation a page draws, has marked-content ids left from an earlier tag tree), `figure_without_image` (the page's images do not pair up with the HTML's `<img>`, so its figures do not contain their images), `owner_restricted` (the owner forbids changes but allows extraction for accessibility, so it was tagged; its form is filled only if the owner allows filling, never flattened, and gets no new fields; the output keeps the owner's permissions), `alignment_incomplete` (the page and the HTML differ too much to match every word in time; the rest is kept as unmatched text).

With `--report-detail`, the report also has `detail`:

- `structure`: the tag tree, each element with its type, page, text (cut to 80 characters), `alt`, `lang`, link `href` and `field` name. At most 2000 elements and 400 kB (`structureTruncated` says if cut).
- `pages`: per page, the words `matched`, left out as `furniture` (headers, footers, page numbers), `added` from the HTML into the added layer, `lost` (`unmatched_text`) and `redrawn` (`duplicate_text_layer`): each a `count` and its first 50 `words`. And the checks: `differingPixels`, `textKept`.
- `fields`: each `created` field's page, box (points from the page's top left) and the label it was placed beside; each `unresolved` field with the warning code that says why.
- `timing`: milliseconds for open, form, read, match, tag, save and check.

It never holds a form value: a flattened field's element gives its `field` name, not its text. To check that an iris-pdf has the option, look for `--report-detail` in `iris-pdf tag --help`.

## Review

`review` checks what `check` cannot: whether the tags say what the page says. For each page it sends a model the page image and what a screen reader gets from the page: the structure, text, alt text, link targets and field names. It reports missing content, wrong reading order, wrong element types or heading levels, tables, alt text, link text, field names and language. It prints one finding per line, writes them to `--report` as JSON with the tokens used and an estimated cost, and exits 0. A page the model could not review is reported with its error, the other pages are kept, and the exit is 1. Nothing in the PDF is changed.

**It sends page images and text to the model provider.** With `ANTHROPIC_API_KEY` set, it uses the Anthropic API. Otherwise it uses Amazon Bedrock through the AWS CLI, with your AWS credentials and region. Choose with `--provider anthropic|bedrock` and `--model <id>`. The default model is Sonnet 5, at about US$0.02 a page; on Bedrock, `--model` takes any model that reads images and calls tools. See [docs/models.md](docs/models.md) for the models compared and their costs.

## PDF/UA

The output declares PDF/UA-1 only when it has a title, every page is tagged, every source font is embedded, and no page drawing has leftover marked content. An optional content (layer) configuration without a name is given one, as PDF/UA-1 requires; one with `/AS`, which PDF/UA-1 forbids, is left as it is and stops the claim (warning `layer_auto_state`), since removing it could change which layers a viewer shows. The tests check each such claim with veraPDF.

## Refusals and exit codes

| Exit | When |
|---|---|
| 0 | Done. |
| 1 | Refused: `encrypted` (no or wrong password), `permissions_denied` (the owner forbids changes, and the PDF has an open password or forbids extraction for accessibility too), `values_not_permitted` and `flatten_not_permitted` (the owner's restrictions allow tagging but not filling in or flattening the form: tag without `--values` or `--flatten`), `too_many_pages` (over 25), `too_many_words` (over 4000 on a page), `xfa` (dynamic form), `signed`, `no_acroform_field`. From `review`: `review_failed` (the model or its API failed on a page). |
| 2 | A check failed: `pixels_changed`, `text_lost`. |
| 3 | Bad input: `unreadable`, `bad_pages`, `no_document_language`, `bad_value`, `field_not_settable`, `bad_arguments`. From `review`: `not_tagged`, `no_readable_structure` (not tagged by this tool), `bad_structure` (nested over 64 levels), `no_credentials`. |

Errors print one line: `iris-pdf: <code>: <message>`.

## Privacy

Form values are personal data. They are never printed, logged, or put in the report or an error message; only field names are. `review` sends page images, which show any filled-in values, to the model provider. After `--flatten` the values are also tagged text, so they are sent as text too and can appear in its findings. From then on they are the page's text: retagging a flattened PDF treats them as any other text, in its report too.

## Known limits

- Page text this tool cannot read code by code is drawn again in the added layer, so it exists twice: the original as an artifact, and ours. Screen readers use ours; plain copy-and-paste tools may show it doubled. The report warns `duplicate_text_layer` and counts these words per page as `redrawn`.
- A table that continues onto the next page is tagged as two tables.
- A figure's image is found by order: the HTML's `<img>`, decorative ones counted, are paired with the page's images top to bottom, left to right. An image drawn inside a form XObject is not found.
- `check` needs veraPDF installed.
- `review` reads only structure tagged by this tool. Its findings are a model's judgment: check them before acting on them. Text in the document can mislead the model, so no findings does not prove a document accessible.
- A flat form's fields are found from the page's lines, so a blank may be missed (`field_not_placed`). Their text is drawn in Helvetica, which is not embedded, so such an output does not claim PDF/UA-1.

## License

[AGPL-3.0-or-later](LICENSE).
