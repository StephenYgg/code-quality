import { expect, test } from "vitest";

import {
  findReferenceCycleComponents,
  findReferenceCycleNodes,
} from "../../../src/instructions/reference-graph.js";

test("finds cycles in a 5000-node graph without recursive stack growth", () => {
  const graph = new Map<string, readonly string[]>();
  for (let index = 0; index < 5_000; index += 1) {
    const node = String(index);
    const next = index === 4_999 ? "2500" : String(index + 1);
    graph.set(node, [next]);
  }

  const cyclic = findReferenceCycleNodes(graph);

  expect(cyclic.has("2499")).toBe(false);
  expect(cyclic.has("2500")).toBe(true);
  expect(cyclic.has("4999")).toBe(true);
  expect(cyclic.size).toBe(2_500);
});

test("separates strongly connected components linked by a one-way edge", () => {
  const graph = new Map<string, readonly string[]>([
    ["a1", ["b1", "a2"]],
    ["a2", ["a1"]],
    ["b1", ["b2"]],
    ["b2", ["b1"]],
  ]);

  const components = findReferenceCycleComponents(graph);

  expect([...(components.get("a1") ?? [])].sort()).toEqual(["a1", "a2"]);
  expect([...(components.get("b1") ?? [])].sort()).toEqual(["b1", "b2"]);
});
