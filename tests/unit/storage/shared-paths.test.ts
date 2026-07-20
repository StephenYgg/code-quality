import { describe, expect, test } from "vitest";

import {
  cacheCoordinationMode,
  cacheEntriesDirectory,
  lockCoordinationMode,
  locksDirectory,
} from "../../../src/storage/paths.js";

describe("coordination paths", () => {
  test("reports local-host-only lock and cache modes", () => {
    const env = { HOME: "/tmp/home" };
    expect(lockCoordinationMode(env)).toBe("local-host-only");
    expect(cacheCoordinationMode(env)).toBe("local-host-only");
  });

  test("shared path configuration does not claim cross-machine fencing", () => {
    const env = { CQ_SHARED_STATE_DIR: "/mnt/cq-shared" };
    expect(lockCoordinationMode(env)).toBe("local-host-only");
    expect(cacheCoordinationMode(env)).toBe("local-host-only");
    expect(locksDirectory(env)).toBe("/mnt/cq-shared/locks");
    expect(cacheEntriesDirectory(env)).toBe("/mnt/cq-shared/cache/entries");
  });

  test("explicit shared lock and cache dirs override", () => {
    const env = {
      CQ_SHARED_LOCK_DIR: "/mnt/locks",
      CQ_SHARED_CACHE_DIR: "/mnt/cache",
    };
    expect(locksDirectory(env)).toBe("/mnt/locks");
    expect(cacheEntriesDirectory(env)).toBe("/mnt/cache");
  });

  test("rejects relative shared dirs", () => {
    expect(() => locksDirectory({ CQ_SHARED_LOCK_DIR: "relative" })).toThrow(
      /absolute/i,
    );
  });
});
