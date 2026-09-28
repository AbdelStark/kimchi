# Offline Routing Benchmark

Labeled prompt → expected-model suite for comparing **laya (System 1, local
decision model)** against Kimchi's existing **LLM router** (the Auto router's
`/v1/route` backend). The runner reports pick agreement, per-category
expected-model accuracy, latency (p50/p95), and routing cost per prompt
(LLM tokens vs $0 local).

## Files

| File          | Contents                                                        |
| ------------- | --------------------------------------------------------------- |
| `suite.jsonl` | The labeled suite — one JSON object per line (see schema below) |
| `suite.ts`    | Candidate roster, zod schema, loader/validator                  |
| `run.ts`      | Benchmark runner (real and `--mock-routers` modes)              |
| `results.json`| Machine-readable results of the latest run (raw prompts never persisted — only ids, picks, latencies) |
| `results.md`  | Human-readable report of the latest run                          |

Results artifacts are committed: they are the evidence for the findings doc.
Every run stamps `summary.meta.mode`; a `mock` marker means the artifact only
proves the pipeline works and must be superseded by a real run before any
quality claim is made.

## Suite schema

```json
{"id":"quick-fix-01","category":"quick-fix","prompt":"Fix the typo ...","expectedModel":"kimi-k2.5-fast","vision":false}
```

- `id` — unique, prefixed by the category.
- `category` — one of the ten buckets below.
- `prompt` — English-only, 10..8000 chars. The `vision` bucket uses a
  `[screenshot/diagram/photo/chart attached]` placeholder prefix; the runner
  marks these queries as vision-bearing (which gates vision-less candidates
  out, mirroring production behavior).
- `expectedModel` — one of the fixed **benchmark candidate roster** below.
- `vision` — whether the query carries image context in production.

## Candidate roster

The suite does not reference live catalog ids; it labels against five *role
archetypes* so the suite stays stable as the real lineup churns. In real mode
the laya sidecar always routes over these five roster candidates. Whatever
either router returns is translated back onto the roster by the explicit
`ARCHETYPE_ALIASES` table in `run.ts` (e.g. `kimi-k2.6` → `kimi-k2.6-code`,
`claude-sonnet-*` → `kimi-k2.6-code`); ids that match no alias are counted as
non-matching and listed under "unmapped" in the report — never silently
coerced. In `--mock-routers` mode both fakes speak roster ids verbatim.

| id                 | blurb                                                                        | vision | context |
| ------------------ | ---------------------------------------------------------------------------- | ------ | ------- |
| `kimi-k3-flagship` | Frontier flagship: general, agentic multi-step tool use, long-context        | yes    | 256k    |
| `kimi-k2.6-code`   | Code-specialized mid-tier: features, refactors, tests, debugging             | no     | 128k    |
| `kimi-k2.5-fast`   | Cheap low-latency model for simple questions, small edits, chat and copy     | no     | 128k    |
| `kimi-k1.6-reason` | Deep-reasoning thinking model: math, proofs, architecture; slower, pricier   | no     | 256k    |
| `kimi-vl-vision`   | Multimodal vision model: screenshots, diagrams, mockups; mid reasoning       | yes    | 128k    |

## Buckets and labeling method

10 buckets × 10 prompts = 100 entries, balanced across the five roles:

| bucket              | expected model       | what distinguishes it                                    |
| ------------------- | -------------------- | -------------------------------------------------------- |
| `agentic-multifile` | `kimi-k3-flagship`   | multi-file, multi-step feature work touched by many tools|
| `code-feature`      | `kimi-k2.6-code`     | moderate, single-purpose code additions                  |
| `code-refactor`     | `kimi-k2.6-code`     | behavior-preserving restructuring                        |
| `test-writing`      | `kimi-k2.6-code`     | new tests / test coverage for existing code              |
| `debugging`         | `kimi-k2.6-code`     | diagnose-and-fix with a regression test                  |
| `quick-fix`         | `kimi-k2.5-fast`     | one-liners, typos, constant tweaks                       |
| `chat-copy`         | `kimi-k2.5-fast`     | explanations, naming, release notes, translations        |
| `deep-reasoning`    | `kimi-k1.6-reason`   | proofs, complexity analysis, design trade-off essays     |
| `long-context`      | `kimi-k3-flagship`   | synthesis over 100k+ token inputs                        |
| `vision`            | `kimi-vl-vision`     | image-attached questions (screenshot/diagram/photo/chart)|

**Ground truth was curated in two passes:** (1) each prompt was labeled by
hand against the role descriptions above (the same matrix Kimchi's Auto router
encodes in its routing instructions); (2) the full suite was run through the
LLM router repeatedly and entries where the LLM router *consistently and
confidently* disagreed with the hand label were re-reviewed — if the argument
of the router was stronger, the label changed with a rationale, otherwise the
label was kept as the deliberately-hard case. Labels therefore encode
*curated intent*, not "whatever the LLM says"; the primary metric for the
thesis is **agreement**, and accuracy-vs-labels is the secondary signal for
where the two routers diverge meaningfully.

Prompt language is English-only. Multilingual routing quality is explicitly
out of scope for the thesis verdict (see the findings doc).

## Running

Prerequisites for a real run:

1. Python 3.10+ with the laya sidecar: `pip install 'laya[serve]'`
   (`kimchi` auto-starts `laya-serve` on demand, or point
   `KIMCHI_LAYA_ENDPOINT` at an already-running instance, or
   `KIMCHI_LAYA_SERVE_CMD` at a venv binary).
2. Kimchi gateway credentials reachable by the LLM router
   (the same `kimchi-dev` provider used by the Auto router), or set
   `KIMCHI_ROUTER_ENDPOINT`/`KIMCHI_ROUTER_API_KEY` explicitly. If these are
   missing, the default run does not fail: it prints a loud notice and
   degrades to a laya-only real run (agreement and LLM-side metrics stay
   unmeasured, `summary.meta.mode` says `real laya-only`).

```bash
pnpm bench:routing                 # real run: laya + LLM router, full suite
pnpm bench:routing --laya-only     # only the laya side (no LLM router calls)
pnpm bench:routing --llm-only      # only the LLM router side
pnpm bench:routing --mock-routers  # deterministic CI mode, no servers needed
```

Results are written to `benchmark/routing/results.json` and
`benchmark/routing/results.md`, and the headline numbers print to stdout.

### Metrics

- **agreement** — share of prompts where laya's pick equals the LLM router's
  pick after both are mapped onto the roster (primary thesis metric).
- **accuracy** — share of prompts where a router's pick equals the curated
  label (secondary; labels are curated intent, see above). Calls that errored
  are excluded from the denominator and counted separately.
- **latency** — p50/p95 (nearest-rank) plus mean of per-prompt router call
  time, per router. For laya this excludes the one-time sidecar startup; note
  the LLM figure includes gateway network round-trip, so it is an upper
  bound on pure decision cost.
- **cost** — the LLM router call returns no usage data, so cost is *estimated*:
  `ceil(promptChars / 4) + 600` input tokens (routing-instruction overhead)
  and 80 output tokens per call. Set `KIMCHI_BENCH_LLM_PRICE_INPUT_PER_1M` /
  `KIMCHI_BENCH_LLM_PRICE_OUTPUT_PER_1M` to additionally get USD figures.
  laya = $0 local, recorded explicitly.
- **calibration** — laya picks carry the server's calibrated
  `answer_confidence`; the summary reports its mean overall and split by
  correct vs incorrect picks (a gap between the two is the signal that the
  score is informative for gating).
- **environment** — every run records platform/arch/CPU/node, the laya
  checkpoint repo (from the server's `routing` metadata), and the LLM
  router backend origin into `summary.meta.environment` so the findings doc
  cites hardware and model build directly from the artifact.

### Environment

| variable                                   | used for                                                        |
| ------------------------------------------ | --------------------------------------------------------------- |
| `KIMCHI_LAYA_ENDPOINT`                     | reuse an already-running `laya-serve` instead of auto-spawning  |
| `KIMCHI_LAYA_API_KEY` / `LAYA_API_KEY`     | bearer auth for the sidecar (if enabled there)                  |
| `KIMCHI_ROUTER_ENDPOINT`                   | LLM router endpoint override (falls back to kimchi-dev gateway) |
| `KIMCHI_ROUTER_API_KEY` / `CASTAI_API_KEY` | LLM router credentials                                          |
| `KIMCHI_BENCH_LLM_PRICE_*_PER_1M`          | optional USD cost estimation input for the LLM side             |

### Interpreting a results file

- **Trust `agreement` first.** The thesis is "decision-model routing matches
  LLM routing quality": if laya picks the same model as the LLM router on
  the same prompt, the two are interchangeable for that prompt regardless of
  whether a human would agree with the pick.
- **Read `accuracy vs labels` as a divergence lens, not ground truth.** Where
  the two routers agree with each other but not with the label, the label is
  the suspect (labels encode curated intent from the same matrix the LLM
  router encodes in its instructions — see the labeling method above). Where
  laya disagrees with *both*, the disagreement table at the bottom of
  `results.md` is the per-prompt audit trail.
- **Compare error counts, not just rates.** A sidecar outage or gateway
  timeout shows up as concentrated errors; accuracy denominators exclude
  errored attempts.
- **Check the `unmapped` note.** If the live lineup drifts beyond the alias
  table, agreement accuracy silently degrades through unmapped ids — the
  report lists them so the table can be extended.
- **A `mock` marker in `summary.meta.mode` invalidates all quality claims.**
  Mock artifacts only prove the pipeline runs; repeat a real run before
  citing numbers.

### `--mock-routers`

CI-safe verification of the full pipeline (loader → two routers → metrics →
artifacts) with deterministic fake routers: the mock LLM router answers from
the suite labels; the mock laya answers labels for a fixed, documented subset
and mis-picks on the rest. This mode does not measure anything about real
routing quality — it only proves the tooling runs end-to-end.
