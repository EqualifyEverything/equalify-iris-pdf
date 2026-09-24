# Models and costs

Where this project uses a Claude model, which one, and what it costs. `tag`, `fields` and `check` use no model and cost nothing to run.

List prices, USD per million tokens (September 2026):

| Model | Input | Output |
|---|---|---|
| Haiku 4.5 | 1 | 5 |
| Sonnet 5 | 2 | 10 |
| Opus 5.5 | 4 | 20 |
| Opus 5 | 5 | 25 |
| Fable 5.1 | 10 | 50 |

These apply to the Anthropic API and to Bedrock's `global.` inference profiles. Bedrock's regional profiles (`us.`, `eu.`, …) cost 10% more. Our AWS organization allows only the `us.` profiles, so the figures below include that 10%.

## `iris-pdf review`: Opus 5.5

**Use Opus 5.5, the default.** If cost matters more than precision, `--model us.anthropic.claude-sonnet-5` (or `claude-sonnet-5`) costs about two thirds as much. Haiku 4.5 is not recommended.

Measured on 2026-09-24 on Bedrock `us.` profiles, with the prompt in `src/review/review.ts`:

| Model | Seeded defects found (of 8) | Findings on 3 clean pages | 25-page scanned report (ACIR): cost, per page, time |
|---|---|---|---|
| Opus 5.5 | 8 | 0 | $0.72, $0.029, 54 s |
| Sonnet 5 | 8 | 0 | $0.47, $0.019, 82 s |
| Haiku 4.5 | 8 | 4 | $0.14, $0.005, 35 s |

- **The seeded defects** were fixture pages tagged from altered HTML: a heading tagged as a paragraph, a skipped heading level, swapped columns, a list and a table tagged as paragraphs, generic alt text, and Chinese text in a document declared English.
- **On real documents** both Opus and Sonnet found real problems: links with no destination, captions that aren't on the page, and OCR noise tagged as text.
  - Sonnet made more mistakes. Before the prompt said so, it misread `Art` (Article) as an artifact. It also writes about twice as many output tokens, which is why it is only about a third cheaper.
  - Haiku reported running headers as missing content despite being told they are artifacts. Once it answered without calling the findings tool.
- **Fable 5.1** was not available on Bedrock to this account when measured. At 2.5 times Opus 5.5's price, it isn't needed for this task.
- **Tokens.** A page is about 4,000 input tokens (the image is most of it) and 300–850 output tokens.

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
