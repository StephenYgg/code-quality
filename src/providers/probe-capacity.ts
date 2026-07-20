export const MAX_CONCURRENT_PROBE_CHILDREN = 128;

export class ProbeChildCapacity {
  private active = 0;

  constructor(private readonly limit: number = MAX_CONCURRENT_PROBE_CHILDREN) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("Probe child capacity must be a positive integer");
    }
  }

  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.limit) return undefined;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  activeCount(): number {
    return this.active;
  }
}
