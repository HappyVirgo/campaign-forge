# campaign-forge benchmark results

- Date: 2026-11-06
- Machine: 12th Gen Intel(R) Core(TM) i7-12700 (16 logical cores), Windows_NT 10.0.26300, Node v24.14.0
- Command: `npm run bench`
- Data: SYNTHETIC customers from `generateCustomers` (4 hidden personas), the hand-labelled set in `bench/compliance-set.json`, simulated experiments.
- Copy generation uses the offline `TemplateCampaignWriter`; no LLM numbers are reported here.

## 1. Segmentation quality (k-means, k chosen by silhouette over 2..8)

| data seed | customers | chosen k | silhouette | purity vs hidden personas | time (s) |
|---|---|---|---|---|---|
| 42 | 2000 | 4 | 0.523 | 0.989 | 0.33 |
| 1 | 2000 | 4 | 0.529 | 0.993 | 0.31 |
| 2 | 2000 | 4 | 0.521 | 0.991 | 0.25 |
| 3 | 2000 | 4 | 0.525 | 0.992 | 0.24 |
| 4 | 2000 | 4 | 0.530 | 0.994 | 0.23 |
| **mean** | | | **0.526** | **0.992** | |

Silhouette by k (seed 42): k=2: 0.378, k=3: 0.468, k=4: 0.523, k=5: 0.443, k=6: 0.386, k=7: 0.334, k=8: 0.266

## 2. Compliance checker on 50 hand-labelled messages

| rule | labelled violations | TP | FP | FN | precision | recall | F1 |
|---|---|---|---|---|---|---|---|
| missing_unsubscribe | 3 | 2 | 0 | 1 | 1.000 | 0.667 | 0.800 |
| missing_opt_out | 2 | 2 | 1 | 0 | 0.667 | 1.000 | 0.800 |
| unverifiable_claim | 16 | 11 | 3 | 5 | 0.786 | 0.688 | 0.733 |
| free_without_disclaimer | 6 | 5 | 1 | 1 | 0.833 | 0.833 | 0.833 |
| **all rules (micro)** | 27 | 20 | 5 | 7 | 0.800 | 0.741 | 0.769 |
| **message-level (any violation)** | 25 | 18 | 5 | 7 | 0.783 | 0.720 | 0.750 |

Disagreements with the labels: e10 (unverifiable_claim: false positive); e11 (free_without_disclaimer: false positive); e12 (unverifiable_claim: missed); e13 (missing_unsubscribe: missed); e16 (free_without_disclaimer: missed); e17 (unverifiable_claim: false positive); s06 (missing_opt_out: false positive); s09 (unverifiable_claim: missed); s11 (unverifiable_claim: missed); s12 (unverifiable_claim: false positive); p08 (unverifiable_claim: missed); m08 (unverifiable_claim: missed).

## 3. Thompson sampling vs fixed even split (4 arms, true rates 0.04, 0.045, 0.05, 0.06, 20000 users, 50 seeds)

| strategy | mean regret (conversions lost) | sd | best-arm traffic share | runs where best arm is the significant winner |
|---|---|---|---|---|
| fixed | 225.0 | 0.8 | 0.250 | 49/50 |
| thompson | 62.3 | 35.5 | 0.759 | 22/50 |

Regret is expected regret, sum over users of (best rate - chosen arm's rate). The last column uses the Bonferroni-corrected z-test vs control (A) at alpha = 0.05; Thompson starves weak arms (including the control) of traffic, so its final z-test has less power even though it routes most users to the best arm: lower regret is bought with weaker inference.

## 4. Variant validation throughput

Full `validateVariant` (channel limits + banned words + compliance) over a pool of 242 variants, cycled to 200,000 validations, single thread, 5 timed runs after one warm-up run.

| median variants/s | min | max |
|---|---|---|
| 406,566 | 396,544 | 413,466 |

(19,021 of the 200,000 validations in the last run reported at least one issue.)
