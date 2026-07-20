import {
  type ReviewProviderSession,
  type ReviewProviderSessionOptions,
  ProviderError,
} from "./provider.js";

export interface ProcessSessionResource {
  release(): Promise<void>;
}

export interface ProcessSessionLease<
  T extends ProcessSessionResource,
> extends ReviewProviderSession {
  readonly resource: T;
}

type SessionState = "pending" | "resolved" | "rejected";

interface SessionEntry<T extends ProcessSessionResource> {
  readonly runId: string;
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  readonly creationTimer: NodeJS.Timeout;
  state: SessionState;
  waiters: number;
  leases: number;
  retired: boolean;
  resource?: T;
  cleanup?: Promise<void>;
}

const MAX_PROVIDER_RUN_SESSIONS = 2;
const MAX_SESSION_CREATION_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

function assertWaiting(options: ReviewProviderSessionOptions): void {
  if (options.signal.aborted) {
    throw new ProviderError("PROVIDER_ABORTED", "Provider call was cancelled");
  }
  if (options.deadline <= Date.now()) {
    throw new ProviderError("PROVIDER_TIMEOUT", "Provider call timed out");
  }
}

function waitForCreation<T extends ProcessSessionResource>(
  entry: SessionEntry<T>,
  options: ReviewProviderSessionOptions,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const remaining = Math.min(
      Math.max(options.deadline - Date.now(), 0),
      MAX_TIMER_MS,
    );
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => {
      finish(() => {
        reject(
          new ProviderError("PROVIDER_ABORTED", "Provider call was cancelled"),
        );
      });
    };
    const timeout = setTimeout(() => {
      finish(() => {
        reject(
          new ProviderError("PROVIDER_TIMEOUT", "Provider call timed out"),
        );
      });
    }, remaining);
    timeout.unref();
    options.signal.addEventListener("abort", onAbort, { once: true });
    void entry.promise.then(
      (resource) => {
        finish(() => {
          resolve(resource);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(
            error instanceof Error
              ? error
              : new ProviderError("PROVIDER_FAILED", "Provider session failed"),
          );
        });
      },
    );
  });
}

export class ProcessProviderSessionManager<T extends ProcessSessionResource> {
  private readonly sessions = new Map<string, SessionEntry<T>>();

  constructor(
    private readonly create: (
      options: ReviewProviderSessionOptions,
    ) => Promise<T>,
  ) {}

  async acquire(
    options: ReviewProviderSessionOptions,
  ): Promise<ProcessSessionLease<T>> {
    assertWaiting(options);
    let entry = this.sessions.get(options.runId);
    if (entry === undefined) {
      if (this.sessions.size >= MAX_PROVIDER_RUN_SESSIONS) {
        throw new ProviderError(
          "PROVIDER_CAPACITY",
          "Provider run session capacity is exhausted",
        );
      }
      entry = this.createEntry(options.runId);
      this.sessions.set(options.runId, entry);
    }
    if (entry.state === "resolved" && entry.resource !== undefined) {
      return this.createLease(entry, entry.resource);
    }
    entry.waiters += 1;
    try {
      const resource = await waitForCreation(entry, options);
      entry.waiters -= 1;
      return this.createLease(entry, resource);
    } catch (error) {
      entry.waiters -= 1;
      void this.retireIfUnused(entry)?.catch(() => undefined);
      throw error;
    }
  }

  private createEntry(runId: string): SessionEntry<T> {
    const controller = new AbortController();
    const deadline = Date.now() + MAX_SESSION_CREATION_MS;
    const creationTimer = setTimeout(() => {
      controller.abort();
    }, MAX_SESSION_CREATION_MS);
    creationTimer.unref();
    const promise = Promise.resolve().then(() =>
      this.create({ runId, signal: controller.signal, deadline }),
    );
    const entry: SessionEntry<T> = {
      runId,
      controller,
      promise,
      creationTimer,
      state: "pending",
      waiters: 0,
      leases: 0,
      retired: false,
    };
    void promise.then(
      (resource) => {
        entry.state = "resolved";
        entry.resource = resource;
        clearTimeout(entry.creationTimer);
        void this.retireIfUnused(entry)?.catch(() => undefined);
      },
      () => {
        entry.state = "rejected";
        clearTimeout(entry.creationTimer);
        if (this.sessions.get(runId) === entry) this.sessions.delete(runId);
      },
    );
    return entry;
  }

  private createLease(
    entry: SessionEntry<T>,
    resource: T,
  ): ProcessSessionLease<T> {
    entry.leases += 1;
    let returned = false;
    let cleanupComplete = false;
    return Object.freeze({
      resource,
      release: async (): Promise<void> => {
        if (cleanupComplete) return;
        if (!returned) {
          returned = true;
          entry.leases -= 1;
        }
        const cleanup = this.retireIfUnused(entry);
        if (cleanup !== undefined) await cleanup;
        cleanupComplete = true;
      },
    });
  }

  private retireIfUnused(entry: SessionEntry<T>): Promise<void> | undefined {
    if (entry.waiters > 0 || entry.leases > 0) return undefined;
    entry.retired = true;
    if (this.sessions.get(entry.runId) === entry) {
      this.sessions.delete(entry.runId);
    }
    if (entry.state === "pending") {
      clearTimeout(entry.creationTimer);
      entry.controller.abort();
      return undefined;
    }
    if (entry.state !== "resolved" || entry.resource === undefined) {
      return undefined;
    }
    if (entry.cleanup !== undefined) return entry.cleanup;
    const cleanup = entry.resource.release();
    entry.cleanup = cleanup;
    void cleanup.catch(() => {
      if (entry.cleanup === cleanup) delete entry.cleanup;
    });
    return cleanup;
  }
}
