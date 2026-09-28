# Routing benchmark results

- Suite: `/Users/abdel/dev/me/kimchi/benchmark/routing/suite.jsonl` (100 prompts)
- Mode: real laya-only
- Started: 2026-09-28T08:33:32.781Z | duration: 7.2s
- LLM router credentials missing (KIMCHI_ROUTER_ENDPOINT + KIMCHI_ROUTER_API_KEY / CASTAI_API_KEY) — degrading to a laya-only real run; agreement and LLM-side metrics stay unmeasured.
- laya-serve spawned at http://127.0.0.1:8000 in 4050ms
- Environment: darwin/arm64, 16x Apple M4 Max, node v24.18.0
- laya checkpoint: convaiinnovations/laya

## Headline

| router | accuracy vs labels | latency p50 | latency p95 | errors | est. routing cost |
| ------ | ------------------ | ----------- | ----------- | ------ | ----------------- |
| laya   | 42.0% (42/100) | 30ms | 34ms | 0 | $0 (local) |

laya mean answer_confidence: 0.335 (correct: 0.377, incorrect: 0.306)

## Per-category

| category | expected model | laya accuracy | LLM accuracy | agreement |
| -------- | -------------- | ------------- | ------------ | --------- |
| agentic-multifile | kimi-k3-flagship | 0.0% | - | - |
| chat-copy | kimi-k2.5-fast | 0.0% | - | - |
| code-feature | kimi-k2.6-code | 100.0% | - | - |
| code-refactor | kimi-k2.6-code | 100.0% | - | - |
| debugging | kimi-k2.6-code | 80.0% | - | - |
| deep-reasoning | kimi-k1.6-reason | 40.0% | - | - |
| long-context | kimi-k3-flagship | 0.0% | - | - |
| quick-fix | kimi-k2.5-fast | 0.0% | - | - |
| test-writing | kimi-k2.6-code | 100.0% | - | - |
| vision | kimi-vl-vision | 0.0% | - | - |

