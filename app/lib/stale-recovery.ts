export type StaleRecoveryObservation = {
  haltLatched: boolean;
  freshMarketCount: number;
  minimumFreshMarkets: number;
  portfolioMarkable: boolean;
  hasError: boolean;
  signature: string;
};

/** Counts distinct healthy source snapshots, not repeated timer checks of one cache entry. */
export class StaleRecoveryTracker {
  private lastSignature: string | null = null;
  private count = 0;

  get healthyObservations(): number { return this.count; }

  reset(): void {
    this.lastSignature = null;
    this.count = 0;
  }

  observe(input: StaleRecoveryObservation): number {
    if (!input.haltLatched || input.freshMarketCount < input.minimumFreshMarkets
      || !input.portfolioMarkable || input.hasError || !input.signature) {
      this.reset();
      return this.count;
    }
    if (input.signature !== this.lastSignature) {
      this.lastSignature = input.signature;
      this.count += 1;
    }
    return this.count;
  }
}
