import { Rng } from "../rng.js";

/** Beta-Bernoulli Thompson-sampling bandit with a uniform Beta(1, 1) prior. */
export class ThompsonSampler {
  readonly successes: number[];
  readonly failures: number[];
  private readonly rng: Rng;

  constructor(
    readonly arms: number,
    seed = 1,
  ) {
    if (arms < 1) throw new RangeError("need at least one arm");
    this.successes = new Array<number>(arms).fill(0);
    this.failures = new Array<number>(arms).fill(0);
    this.rng = new Rng(seed);
  }

  /** Draws one sample from each arm's posterior and returns the arm with the largest draw. */
  choose(): number {
    let best = 0;
    let bestDraw = -1;
    for (let i = 0; i < this.arms; i++) {
      const draw = this.rng.beta(1 + this.successes[i]!, 1 + this.failures[i]!);
      if (draw > bestDraw) {
        bestDraw = draw;
        best = i;
      }
    }
    return best;
  }

  /** Records a binary reward for an arm. */
  update(arm: number, converted: boolean): void {
    if (converted) this.successes[arm]!++;
    else this.failures[arm]!++;
  }

  /** Monte Carlo estimate of P(arm is best) under the current posteriors. */
  probabilityBest(draws = 10_000): number[] {
    const wins = new Array<number>(this.arms).fill(0);
    for (let d = 0; d < draws; d++) wins[this.choose()]!++;
    return wins.map((w) => w / draws);
  }
}
