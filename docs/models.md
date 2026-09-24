# Models and costs

Where this project uses a model, which one, and what it costs. `tag`, `fields` and `check` use no model and cost nothing to run.

Claude list prices, USD per million tokens (September 2026):

| Model | Input | Output |
|---|---|---|
| Haiku 4.5 | 1 | 5 |
| Sonnet 5 | 2 | 10 |
| Opus 5.5 | 4 | 20 |
| Opus 5 | 5 | 25 |
| Fable 5.1 | 10 | 50 |

These apply to the Anthropic API and to Bedrock's `global.` inference profiles. Bedrock's regional profiles (`us.`, `eu.`, …) cost 10% more. Our AWS organization allows only the `us.` profiles, so the figures below include that 10%. Other vendors' models on Bedrock are billed at AWS's published rates.

## `iris-pdf review`: Sonnet 5

**Use Sonnet 5, the default.** It found as much as any model we measured, at the lowest price among the best. On a budget, **`--model us.openai.gpt-5.6-luna`** (Bedrock only) costs about a fifteenth as much and misses a little more.

On Bedrock, `review` uses the Converse API, so `--model` takes any Bedrock model that reads images and calls tools.

### How it was measured

On 2026-09-24, through Bedrock `us.` profiles, with the prompt in `src/review/review.ts`. The method follows equalify-iris's verifier calibration: count both what a model catches and what it invents.

- **Corpus: 26 one-page PDFs.**
  - 8 real pages from a 1962 scanned report (ACIR), tagged from equalify-iris's HTML.
  - 8 of this repo's fixtures.
  - 10 damaged copies with one defect each: a heading as a paragraph, a skipped heading level, two paragraphs swapped, a table as a paragraph, header cells as data cells, generic alt text, wrong alt text, a figure left untagged, a document language that is wrong, and a paragraph that is not on the page.
- **Defects caught:** a finding of the right kind that names the defect.
- **Real problems found:** the clean copies turned out to hold 15 real problems the tagger left. They are stray OCR fragments, dot leaders tagged as text, a title tagged twice, table cells pointing at a missing header, a link with no text, a figure with no image, and an unnamed button. These were checked by hand against the page images.
- **False positives:** findings on clean copies that are neither of those. An example is a running header reported as missing, though artifacts are excluded by design.
- **Draws:** three for the leaders and two for the rest. First, 26 models from 10 vendors were screened with one draw.

| Model | Defects caught | Real problems found | False positives per page | Per 100 pages |
|---|---|---|---|---|
| Kimi K3 | 30/30 | 43/45 | 0.02 | $3.31 |
| Opus 5.5 | 30/30 | 41/45 | 0.04 | $2.62 |
| **Sonnet 5** | 30/30 | 40/45 | 0.04 | **$1.93** |
| GPT-5.6 sol | 30/30 | 39/45 | 0 | not published |
| GPT-6 astra | 30/30 | 38/45 | 0 | not published |
| GPT-5.5 | 20/20 | 27/30 | 0 | not published |
| GPT-6 sol | 20/20 | 23/30 | 0 | not published |
| GPT-5.4 | 20/20 | 24/30 | 0.59 | $1.10 |
| GPT-5.6 terra | 20/20 | 23/30 | 0.16 | $1.03 |
| GPT-6 luna | 20/20 | 18/30 | 0.31 | not published |
| **GPT-5.6 luna** | 28/30 | 38/45 | 0.15 | **$0.13** |
| Haiku 4.5 | 19/20 | 22/30 | 0.63 | $0.56 |
| Kimi K2.5 | 18/20 | 25/30 | 0.63 | $0.29 |
| Mistral Large 3 | 19/20 | 19/30 | 1.59 | $0.24 |

- **The leaders tie within the noise.** Kimi K3, Opus 5.5, Sonnet 5, GPT-5.6 sol, GPT-6 astra and GPT-5.5 all caught every defect and invented almost nothing. Sonnet 5 is the cheapest of them with a published price.
- **GPT-5.5, GPT-5.6 sol and the GPT-6 models** have no rate in AWS's price list, so their cost is unknown. Measure them again once they are priced.
- **GPT-5.6 luna** missed a heading tagged as a paragraph and header cells tagged as data cells, once each. It sometimes reports running headers. Its rate is published only for us-gov-west-1, and GovCloud rates tend to be higher, so treat its cost as an upper bound.
- **Screened out after one draw:**
  - Llama 4 Maverick, Pixtral Large, Ministral 14B, Qwen3 VL 235B and Nova Pro caught 6 to 9 of 10 defects, with up to 2.4 false positives a page.
  - Grok 4.6 failed 9 of 27 pages, mostly by running past 4,096 output tokens.
  - Nova 2 Lite caught 1 defect; Llama 4 Scout caught none.
  - Gemma 3 and Nemotron Nano 2 VL never called the tool.
  - Nova Premier has reached end of life.
  - Fable 5.1 was unavailable on Bedrock to this account.
- **The corpus is small**, and the leaders caught every defect in it. Widen it before choosing between them. The corpus and harness are not in this repo yet.
- **Tokens.** Averaged over the corpus, Sonnet 5 uses about 3,800 input and 1,000 output tokens a page; GPT-5.6 luna, about 1,800 and 500.

The review sends each page's image and its text to the model provider, so do not use it on documents that must not leave your machine.

## The PR reviewer: Opus 5, moving to Opus 5.5

`.github/workflows/code-review.yml` runs Claude Code on Bedrock. Its model is the repository variable `BEDROCK_REVIEW_MODEL`, and defaults to `us.anthropic.claude-opus-5`.

Over its last 18 successful runs, a review cost $0.30 to $2.67, **$1.44 on average**, in 7 to 30 turns taking 1 to 10 minutes. Claude Code reports these figures at list price, so on the `us.` profile add about 10%. Each push to a PR is reviewed again, so a PR that takes several rounds costs several reviews.

**Recommended: Opus 5.5.** It is newer, and its list price is 20% lower, so a review would cost about $1.15 on average. To switch:

1. Add `us.anthropic.claude-opus-5-5` to the review role's Bedrock policy (`equalify-iris-gha-bedrock-review`, policy `bedrock-invoke-opus5`). It needs the inference profile ARN plus the `anthropic.claude-opus-5-5` foundation-model ARNs in its regions, as the policy has for Opus 5.
2. Set the repository variable `BEDROCK_REVIEW_MODEL` to `us.anthropic.claude-opus-5-5`.

Keep review on an Opus model. Its job is to find what the author missed, and that is where the cheaper models are weakest.

## The maintainer agent: Opus 5.5

The Iris PDF Maintainer runs in Claude Code on Opus 5.5, which suits design, multi-file changes and weighing review findings. Claude Code meters its sessions, not this repo, so there is no per-task figure here. As a guide, a working session reads a great deal of code, and most of that is cached input, which Opus 5.5 bills at $0.20 per million tokens. Broad searches it hands to subagents can run on Sonnet 5 or Haiku 4.5 for less.
