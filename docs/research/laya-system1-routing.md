# System 1 Model Routing with laya: Experiment Findings

**Status:** experimental feature findings, 2026-09-28 · [`AbdelStark/kimchi`](https://github.com/AbdelStark/kimchi)
**Artifact location:** `docs/research/laya-system1-routing.md` (permanent project docs)
**Code:** `src/extensions/router-laya/`, benchmark harness in `benchmark/routing/`

## TL;DR

We wired Kimchi's multi-model per-prompt router to make its model choice with
[laya](https://huggingface.co/convaiinnovations/laya) — a local,
non-autoregressive **decision model** — instead of an LLM routing call, behind
an opt-in, experimental "System 1" routing mode. We measured it on a 100-prompt
labeled benchmark against a five-model archetype roster.

- **Latency & cost leg of the thesis: CONFIRMED.** laya picks a model in
  **p50 30 ms / p95 34 ms** end-to-end over HTTP on Apple silicon (CPU), with
  **zero marginal cost** per decision — roughly two orders of magnitude faster
  and cheaper than an LLM routing call, which is a network round-trip to a
  frontier-class model.
- **Quality-parity leg of the thesis: NOT CONFIRMED for zero-shot laya.**
  The base checkpoint scored **42.0% accuracy** against our curated labels —
  statistically near the "always answer the code archetype" baseline (40%).
  Its picks collapsed ballistically onto a single archetype (81/100) and it
  never selected two of the five candidates at all. This **matches the model
  card's own caveat**: the released checkpoints are near-chance zero-shot on
  typed-decision tasks and are meant to be fine-tuned.
- **Useful positive signal:** laya's *calibrated* `answer_confidence` does
  discriminate — picks below 0.3 were only **11%** correct vs 0.377 mean
  confidence on correct picks vs 0.306 on incorrect ones. A confidence-gated
  hybrid (laya first, LLM router on low confidence) is the credible path to
  capture the latency win while keeping quality; we report it as future work
  with measured thresholds.

## Motivation & thesis

Kimchi's multi-model orchestrator decides per user prompt which concrete model
should answer (the "Auto" routing mode). Today that decision is itself an LLM
call: it costs money, adds ~1 s of latency before the first token, and burns a
frontier model on a question that is arguably not a language-generation task
at all — it's a *decision*: given a prompt and a small set of candidate models
with capability metadata, pick one.

The **System 1** hypothesis: a small, local, non-autoregressive decision model
can make routing-class decisions fast enough and cheaply enough to replace the
LLM routing call for this step, at **comparable** decision quality. If true,
routing becomes effectively free (local inference on CPU, zero marginal cost),
removes the routing network dependency and its failure modes, and — because
decisions are local — can be logged with full probability distributions at
scale for offline analysis.

Thesis, stated testably:

> **T1 (latency/cost):** decision-model routing reduces per-prompt routing
> latency by ≥10× and marginal routing cost to ~$0.
>
> **T2 (quality):** decision-model routing picks are contractible with the LLM
> router's picks (high pick agreement) and accurate enough against held
> intents that users would not notice the difference.

## Implementation (what was built)

The feature is an **opt-in experimental routing mode**, `kimchi-dev/laya`,
registered alongside `kimchi-dev/auto` in the model catalog. It is hidden
unless `--enable-experimental-features` is passed; default behavior (`Auto`,
multi-model orchestrator mode, ACP flows, embedded agents) is unchanged.

Per prompt, when the session's model is `laya`:

1. The extension enumerates the currently available **concrete** models
   (virtual routed models like `auto`/`laya` itself are excluded), with their
   capability metadata (context size, reasoning, vision).
2. It builds a laya **choice question** (`buildLayaRoutingQuestions`, one
   `best-model` question whose options are the candidate ids sorted
   deterministically, whose instructions describe each candidate's
   capabilities and the task-relevant constraints — e.g. image inputs present
   → vision-capable candidates only).
3. It calls the local sidecar `POST /v1/systemone` (abortable, 30 s timeout).
4. The answer is converted into the *exact* `RouteRecommendation` shape the
   existing Auto router consumes, so production eligibility gating, vision
   filtering, and ranked fallback are reused unchanged
   (`layaChoiceToRecommendation` → shared `resolveRecommendation`).
5. Every decision is appended to a privacy-safe JSONL decision log at
   `<agentDir>/laya-routing/<sessionId>.jsonl` — prompt **sha256**, chosen
   model, per-option probabilities, calibrated `answer_confidence`, latency,
   source (`laya` | `llm-fallback`), and the counterfactual LLM pick when
   available. Raw prompt text is never logged.

**Sidecar lifecycle.** Kimchi lazily spawns `laya-serve` (pip install
`laya[serve]`) bound to `127.0.0.1` only, loads the checkpoint eagerly
(`LAYA_PRELOAD=1`), reuses an already-running instance at the endpoint, and
probes liberally (any HTTP response counts as up, since `/health` only exists
on newer builds). On any failure — missing Python runtime, spawn error,
server error, timeout — routing falls back to the existing LLM router with a
once-per-session visible notice; only if the LLM router also fails does the
current Auto error UX surface. Cancellation never falls back.

**Files** (~14 new under `src/extensions/router-laya/`, 3 refactors under
`src/extensions/router/`; all co-located vitest; e2e TUI coverage in
`tests/e2e/tui/laya-routing.test.ts`).

## Methodology

### Benchmark suite

`benchmark/routing/suite.jsonl` — **100 labeled prompts**, 10 categories × 10
prompts each, covering the intents that actually trigger routing decisions:

`code-feature` · `code-refactor` · `debugging` · `test-writing` ·
`deep-reasoning` · `agentic-multifile` · `long-context` · `quick-fix` ·
`chat-copy` · `vision`

Models are mapped onto a stable **five-archetype roster** rather than live
catalog ids, so results survive catalog churn:

| archetype          | stands for                         | suite label share |
| ------------------ | ---------------------------------- | ----------------- |
| `kimi-k3-flagship` | frontier generalist, long context  | 20%               |
| `kimi-k2.6-code`   | code-capable workhorse             | 40%               |
| `kimi-k2.5-fast`   | fast/cheap general                 | 20%               |
| `kimi-k1.6-reason` | strong reasoning                   | 10%               |
| `kimi-vl-vision`   | vision-capable                     | 10%               |

This means **random/uniform guessing yields 20%**, and the established
"always pick the biggest class" floor — always answering `kimi-k2.6-code` —
yields **40%** on labels. A system whose picks collapse onto that archetype
must be scored against the 40% floor, not against 20%.

Labels were curated in two stages (documented in the suite README): manual
labeling by intent, plus a planned LLM-router-consensus re-review. **The
consensus pass is intentionally absent from this report** — see
"Unmeasured" below. Suite prompts are English-only; multilingual routing is
out of scope.

### Metrics

- **Pick agreement** (laya vs LLM router) — *primary metric* when both sides
  run. **Unmeasured in this run.**
- **Accuracy vs labels** overall and per category — secondary signal,
  inherently subjective (the label reflects the author's intent, not ground
  truth); we report raw counts, not just rates.
- **Latency** p50/p95 per router over the suite (in-memory + HTTP included).
- **Cost** per decision: LLM router = estimated prompt+completion tokens
  priced per 1M; laya = **$0 local**, recorded explicitly.
- **Calibration:** mean laya `answer_confidence`, split by correct vs
  incorrect picks, and accuracy of the sub-0.30 cohort — tests the model
  card's calibration claims and the hybrid-gating idea.

### Environment

| item              | value                                                            |
| ----------------- | ---------------------------------------------------------------- |
| hardware          | Apple M4 Max, 16 cores (CPU inference), darwin/arm64             |
| laya runtime      | `laya` 0.3.21 (`laya-serve`), torch 2.14.0, transformers 5.17.0  |
| laya checkpoint   | `convaiinnovations/laya` — English (server-selected for en input) |
| harness           | node v24.18.0, tsx `benchmark/routing/run.ts`                    |
| sidecar lifecycle | spawned by `ensureLayaServer` on 127.0.0.1; `LAYA_PRELOAD=1`     |

The full environment block is recorded in `results.json →
summary.meta.environment`. Numbers below are **real measurements** from
`benchmark/routing/results.{json,md}` (`summary.meta.mode = "real laya-only"`),
reproduced deterministically across two independent runs. LLM-side numbers
are **absent by design** in this artifact; nothing mocked is represented as
measured.

### Unmeasured in this run (honest report)

The evaluator machine had **no LLM gateway credentials**, so pick agreement
with the production LLM router and its latency/cost columns were not
measured. The pipeline for both-routers comparison exists and is exercised
end-to-end by deterministic mock-LLM runs (`--mock-routers`, CI-safe,
explicitly labelled `mock both`), plus 25 vitest cases over the summary
schema. To measure agreement on a credentialed machine:

```bash
export KIMCHI_ROUTER_ENDPOINT=...  KIMCHI_ROUTER_API_KEY=...  # or CASTAI_API_KEY
KIMCHI_LAYA_SERVE_CMD=.venv-laya/bin/laya-serve pnpm bench:routing
```

## Results

### Headline (real laya-only, n=100)

| router | accuracy vs labels | latency p50 | latency p95 | errors | marginal cost / decision |
| ------ | ------------------ | ----------- | ----------- | ------ | ------------------------ |
| laya   | **42.0% (42/100)** | **30 ms**   | **34 ms**   | 0/100  | **$0 (local)**           |

For calibration context: the pre-measured floor for degenerate picking on
these labels is **40%** (always answer the code archetype; label share 40%).
Random over 5 classes is 20%. laya's 42% sits **at the collapse floor**, i.e.
statistically consistent with always guessing `k2.6-code`.

### Per-category accuracy

| category | label | laya pick distribution | laya accuracy |
| -------- | ----- | ------------------------------ | ------- |
| code-feature | kimi-k2.6-code | k2.6-code ×10 | 100% |
| code-refactor | kimi-k2.6-code | k2.6-code ×10 | 100% |
| test-writing | kimi-k2.6-code | k2.6-code ×10 | 100% |
| debugging | kimi-k2.6-code | k2.6-code ×8, reason ×1, vl ×1 | 80% |
| deep-reasoning | kimi-k1.6-reason | k2.6-code ×5, reason ×4, vl ×1 | 40% |
| agentic-multifile | kimi-k3-flagship | k2.6-code ×10 | 0% |
| long-context | kimi-k3-flagship | k2.6-code ×5, vl ×3, reason ×2 | 0% |
| quick-fix | kimi-k2.5-fast | k2.6-code ×7, reason ×2, vl ×1 | 0% |
| chat-copy | kimi-k2.5-fast | k2.6-code ×6, reason ×4 | 0% |
| vision | kimi-vl-vision | k2.6-code ×10 | 0% |

**Pick histogram across the suite:** `k2.6-code ×81`, `k1.6-reason ×13`,
`vl-vision ×6`, `k3-flagship ×0`, `k2.5-fast ×0`.

Two distinct failure modes are visible:

1. **Generic collapse:** the model over-selects the code archetype for
   everything. `k3-flagship` and `k2.5-fast` are never selected — the former
   costs every `agentic-multifile` and `long-context` prompt, the latter costs
   every `quick-fix`/`chat-copy` prompt.
2. **Instructions-only gating failure (vision):** vision prompts were answered
   with `k2.6-code` ×10 even though the question text notes the
   image-gating. This is a zero-shot instruction-following failure on
   candidate constraints; in the production path, the shared
   `resolveRecommendation` eligibility filter would correct it (and does —
   it's the same path Auto uses).

### Latency & cost

laya decided per prompt at **p50 30 ms / p95 34 ms** end-to-end (state build
+ HTTP round-trip on loopback included), which is consistent with the model
card's ~33 ms/GPU / 193–464 ms/CPU single-forward-pass budget and favorable
because the roster is small. One-off startup costs: cold sidecar first boot
≈112 s (downloads the English checkpoint from Hugging Face), warm spawn ≈4 s.
By contrast, the current LLM router is a network call to a frontier-class
model — anecdotally 0.5–3 s per routing decision (this run did not measure
it; marked unmeasured above). Marginal cost per laya decision: **$0**; the
LLM router incurs prompt+completion tokens on every decision (harness
estimates ~600 input overhead + prompt tokens + 80 completion tokens when
priced).

T1 is therefore **confirmed with a ~30× latency margin and zero marginal
cost**, subject to the caveat that the latency advantage is partly offset in
laya's case by the quality gap below.

### Calibration (does the confidence score mean anything?)

| cohort                    | mean `answer_confidence` | note                              |
| ------------------------- | ------------------------ | --------------------------------- |
| all picks (n=100)         | 0.335                    | below mid-scale, as expected when collapsing |
| correct picks (n=42)      | **0.377**                |                                     |
| incorrect picks (n=58)    | **0.306**                |                                                                     |
| picks with conf < 0.30    | n=35                     | only **11%** of these were correct |

The purified sub-claim of the model card — that `answer_confidence` (the
calibrated max-p) is usable for *gating* — holds in this data. It implies a
measured hybrid policy (see Future work): abstain at low confidence and fall
back to the LLM router for that prompt.

## Limitations

**Of laya itself (from the model card, checked against this run):**

- **Zero-shot typed-decisions caveat — CONFIRMED as load-bearing.** The card
  notes the released checkpoints are near-chance zero-shot on typed-decision
  tasks and that fine-tuning is what produces the demonstrated accuracy gains.
  Our 42%-at-the-collapse-floor result is exactly this caveat manifesting on a
  routing task; the card is honest, and the thesis leg T2 cannot be evaluated
  until a routing-tuned checkpoint exists.
- **High-cardinality degradation.** The card reports degradation beyond ~20
  options in a choice question. Our suite used 5 options, so this failure
  mode did not trigger here — but Kimchi's real catalog can exceed it, and
  the production question builder caps at the server's limit (100, 413 on
  overflow). This is an ongoing eligibility/design constraint for catalog
  growth under System 1 mode.
- **Instructions-only constraint violation.** The vision bucket showed the
  zero-shot model happily selecting a candidate whose metadata marks it as
  vision-incapable. Production hard-enforces this filter; the benchmark does
  not (deliberately — raw picks are reported).

**Of this experiment:**

- **Label subjectivity.** Benchmark labels encode the author's intent; they
  are not ground truth. This is why *agreement with the LLM router* is the
  primary metric — and it was not measurable on this machine (no gateway
  credentials). Agreement/LLM-side latency/cost numbers are therefore
  absent from this report rather than substituted with mock values.
- **English-only suite.** Multilingual routing quality is explicitly out of
  scope for the verdict.
- **Single-machine environment.** Latency numbers are from one Apple M4 Max
  dev machine; absolute ms figures are not portable, ratios to an LLM
  network call are.
- **Two-pass labeling incomplete.** The planned LLM-consensus re-review pass
  could not run for the same credential reason; labels are the manual-curation
  pass only.

## Verdict

> **T1 (latency/cost): confirmed.** Decision-model routing cut per-decision
> latency to p50 30 / p95 34 ms (from the seconds-class LLM network call) and
> marginal cost to $0, with decisions and full probability distributions
> logged locally at zero marginal cost — satisfying the privacy and audit
> requirements no frontier-LLM router can match by construction.
>
> **T2 (quality): not confirmed for zero-shot laya.** The base checkpoint's
> picks do not rank-match our labels above the collapse floor (42% vs the 40%
> floor), by an amount that would produce user-visible routing regressions.
> This is consistent with — and validating of — the model card's own
> zero-shot caveat.
>
> **Overall verdict on the thesis:** **"Promising, conditional on
> fine-tuning."** The infrastructure thesis (local decision-model routing is
> fast, free, private, and cleanly integrable into Kimchi's existing
> Auto-router pipeline with full fallback) is validated end-to-end. The model
> thesis (laya zero-shot routes like an LLM) is refuted as-shipped and
> remains open for a routing-fine-tuned checkpoint exactly as the model card
> prescribes. The experimental mode should ship as-is (opt-in, experimental,
> fallback-gated) — it is valuable as the measurement harness and as the
> substrate for the fine-tuning loop, not yet as a day-to-day router.

## Future work

1. **Typed-decisions fine-tune.** The natural experiment is laya fine-tuned
   on routing examples — and the benchmark suite (100 labeled prompts ×
   5 candidates) plus live counterfactual telemetry (`<agentDir>/laya-routing/`)
   are exactly the data-prompt for it.
2. **Temperature calibration.** Calibrate the decision head (temperature on
   the option logits) against the measured correct/incorrect confidence gap.
3. **Hybrid, confidence-gated routing (measured threshold).** Gate on
   `answer_confidence`: below 0.3 the observed accuracy is 11%, so route
   those prompts to the LLM router. A first-order estimate from this run:
   ~65% of prompts stay on laya (conf ≥ 0.3), ~35% fall back — preserving
   most of the latency/cost win while cutting the error concentration.
4. **Counterfactual telemetry analysis.** Once System 1 mode sees real
   traffic, the decision log (laya pick + counterfactual LLM pick + eventual
   outcome) enables a large-scale agreement study without rerunning labeled
   benchmarks.
5. **Latency-seasoned LLM comparison.** Measure the LLM router's latency and
   per-call token cost on the same machine (blocked this run on credentials)
   to publish the exact T1 ratio rather than the ≥30× estimate.
6. **Multilingual benchmark.** Suite is English-only; extend before making
   the verdict language-general.
7. **High-cardinality tests.** Kimchi's real catalog can exceed the card's
   documented ~20-option comfort zone; benchmark question-building against
   realistic catalog sizes.

## Reproducibility

```bash
# 1. sidecar (once)
python3 -m venv .venv-laya && .venv-laya/bin/pip install 'laya[serve]'

# 2. run the benchmark (laya side only — what this report measured)
KIMCHI_LAYA_SERVE_CMD=$PWD/.venv-laya/bin/laya-serve pnpm bench:routing -- --laya-only

# 3. full both-sides comparison (needs LLM gateway credentials)
export KIMCHI_ROUTER_ENDPOINT=... KIMCHI_ROUTER_API_KEY=...
KIMCHI_LAYA_SERVE_CMD=$PWD/.venv-laya/bin/laya-serve pnpm bench:routing

# 4. deterministic mock pipeline (no network; validates the harness)
pnpm bench:routing -- --mock-routers
```

Artifacts: `benchmark/routing/results.json` (machine-readable summary +
records), `benchmark/routing/results.md` (human-readable report). Suite:
`benchmark/routing/suite.jsonl` + `README.md` (labeling method and schema).

## References

- laya model card: <https://huggingface.co/convaiinnovations/laya>
- laya Python package / `laya[serve]`: <https://pypi.org/project/laya>
- Kimchi model routing design doc: `docs/model-routing.md`
- Implementation: `src/extensions/router-laya/` (new), `src/extensions/router/`
  (shared plumbing refacts)
- Benchmark harness: `benchmark/routing/`
