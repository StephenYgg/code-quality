import { describe, expect, test, vi } from "vitest";

import {
  type ReviewProviderSessionOptions,
  ProviderError,
} from "../../../src/providers/provider.js";
import {
  ProcessProviderSessionManager,
  type ProcessSessionLease,
  type ProcessSessionResource,
} from "../../../src/providers/process-provider-session.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    promise,
    resolve(value: T): void {
      resolve?.(value);
    },
  };
}

function resource(): ProcessSessionResource & {
  readonly release: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return { release: vi.fn(() => Promise.resolve()) };
}

function options(
  runId: string,
  controller: AbortController,
  deadline: number,
): ReviewProviderSessionOptions {
  return { runId, signal: controller.signal, deadline };
}

async function outcome<T extends ProcessSessionResource>(
  promise: Promise<ProcessSessionLease<T>>,
): Promise<ProcessSessionLease<T> | string> {
  return promise.catch((error: unknown) =>
    error instanceof ProviderError ? error.code : "UNKNOWN_ERROR",
  );
}

async function releaseLease(value: unknown): Promise<void> {
  if (
    value !== null &&
    typeof value === "object" &&
    "release" in value &&
    typeof value.release === "function"
  ) {
    await (value as ProcessSessionLease<ProcessSessionResource>).release();
  }
}

describe("process provider pending sessions", () => {
  test.each(["first", "second"] as const)(
    "%s waiter can cancel without interrupting the other waiter",
    async (cancelled) => {
      const creation = deferred<ProcessSessionResource>();
      let creationOptions: ReviewProviderSessionOptions | undefined;
      const manager = new ProcessProviderSessionManager((value) => {
        creationOptions = value;
        return creation.promise;
      });
      const firstController = new AbortController();
      const secondController = new AbortController();
      const startedAt = Date.now();
      const first = manager.acquire(
        options("shared-run", firstController, startedAt + 1_000),
      );
      const second = manager.acquire(
        options("shared-run", secondController, startedAt + 2_000),
      );
      const cancelledPromise = cancelled === "first" ? first : second;
      const survivingPromise = cancelled === "first" ? second : first;
      const cancelledController =
        cancelled === "first" ? firstController : secondController;

      cancelledController.abort();
      const cancelledOutcome = await Promise.race([
        outcome(cancelledPromise),
        new Promise<"still-pending">((resolve) => {
          setTimeout(() => {
            resolve("still-pending");
          }, 150);
        }),
      ]);
      expect(cancelledOutcome).toBe("PROVIDER_ABORTED");
      expect(creationOptions?.signal.aborted).toBe(false);
      expect(creationOptions?.signal).not.toBe(firstController.signal);
      expect(creationOptions?.signal).not.toBe(secondController.signal);
      expect(creationOptions?.deadline).toBeGreaterThan(startedAt + 2_000);
      expect(creationOptions?.deadline).toBeLessThanOrEqual(startedAt + 30_500);

      const created = resource();
      creation.resolve(created);
      const surviving = await survivingPromise;
      await surviving.release();
      expect(created.release).toHaveBeenCalledTimes(1);
      await releaseLease(await outcome(cancelledPromise));
    },
  );

  test("each waiter enforces its own deadline", async () => {
    const creation = deferred<ProcessSessionResource>();
    let creationOptions: ReviewProviderSessionOptions | undefined;
    const manager = new ProcessProviderSessionManager((value) => {
      creationOptions = value;
      return creation.promise;
    });
    const startedAt = Date.now();
    const short = manager.acquire(
      options("deadline-run", new AbortController(), startedAt + 30),
    );
    const long = manager.acquire(
      options("deadline-run", new AbortController(), startedAt + 1_000),
    );

    const shortOutcome = await Promise.race([
      outcome(short),
      new Promise<"still-pending">((resolve) => {
        setTimeout(() => {
          resolve("still-pending");
        }, 150);
      }),
    ]);
    expect(shortOutcome).toBe("PROVIDER_TIMEOUT");
    expect(creationOptions?.signal.aborted).toBe(false);

    const created = resource();
    creation.resolve(created);
    const lease = await long;
    await lease.release();
    expect(created.release).toHaveBeenCalledTimes(1);
    await releaseLease(await outcome(short));
  });

  test("aborts shared creation only after every pending waiter leaves", async () => {
    let activeCreations = 0;
    let internalSignal: AbortSignal | undefined;
    const manager = new ProcessProviderSessionManager((value) => {
      if (value.runId === "recovered-run") return Promise.resolve(resource());
      internalSignal = value.signal;
      activeCreations += 1;
      return new Promise<ProcessSessionResource>((_resolve, reject) => {
        value.signal.addEventListener(
          "abort",
          () => {
            activeCreations -= 1;
            reject(new ProviderError("PROVIDER_ABORTED", "creation aborted"));
          },
          { once: true },
        );
      });
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = manager.acquire(
      options("cancel-all-run", firstController, Date.now() + 1_000),
    );
    const second = manager.acquire(
      options("cancel-all-run", secondController, Date.now() + 1_000),
    );

    firstController.abort();
    expect(await outcome(first)).toBe("PROVIDER_ABORTED");
    expect(internalSignal?.aborted).toBe(false);
    expect(activeCreations).toBe(1);
    secondController.abort();
    expect(await outcome(second)).toBe("PROVIDER_ABORTED");
    expect(internalSignal?.aborted).toBe(true);
    expect(activeCreations).toBe(0);

    const recovered = await manager.acquire(
      options("recovered-run", new AbortController(), Date.now() + 1_000),
    );
    await recovered.release();
  });

  test("settle and cancellation interleaving releases exactly once", async () => {
    const creation = deferred<ProcessSessionResource>();
    const created = resource();
    const manager = new ProcessProviderSessionManager(() => creation.promise);
    const controller = new AbortController();
    const waiter = manager.acquire(
      options("interleaved-run", controller, Date.now() + 1_000),
    );

    creation.resolve(created);
    controller.abort();
    const result = await outcome(waiter);
    expect(result).toBe("PROVIDER_ABORTED");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(created.release).toHaveBeenCalledTimes(1);
    await releaseLease(result);
  });

  test("allows a failed resource cleanup to be retried by the releasing lease", async () => {
    let cleanupFails = true;
    const created = resource();
    created.release.mockImplementation(() => {
      return cleanupFails
        ? Promise.reject(new Error("controlled session cleanup failure"))
        : Promise.resolve();
    });
    const manager = new ProcessProviderSessionManager(() =>
      Promise.resolve(created),
    );
    const lease = await manager.acquire(
      options("cleanup-retry-run", new AbortController(), Date.now() + 1_000),
    );

    await expect(lease.release()).rejects.toThrow(
      "controlled session cleanup failure",
    );
    expect(created.release).toHaveBeenCalledTimes(1);
    cleanupFails = false;
    await lease.release();
    await lease.release();
    expect(created.release).toHaveBeenCalledTimes(2);
  });
});
