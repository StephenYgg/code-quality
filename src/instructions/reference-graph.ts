function graphNodes(
  graph: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const nodes = new Set(graph.keys());
  for (const targets of graph.values()) {
    for (const target of targets) {
      nodes.add(target);
    }
  }
  return nodes;
}

function finishingOrder(
  graph: ReadonlyMap<string, readonly string[]>,
  nodes: ReadonlySet<string>,
): string[] {
  const visited = new Set<string>();
  const finished: string[] = [];
  for (const start of nodes) {
    if (visited.has(start)) {
      continue;
    }
    visited.add(start);
    const stack: Array<{ readonly node: string; nextTarget: number }> = [
      { node: start, nextTarget: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) {
        break;
      }
      const target = (graph.get(frame.node) ?? [])[frame.nextTarget];
      if (target !== undefined) {
        frame.nextTarget += 1;
        if (!visited.has(target)) {
          visited.add(target);
          stack.push({ node: target, nextTarget: 0 });
        }
        continue;
      }
      stack.pop();
      finished.push(frame.node);
    }
  }
  return finished;
}

function reverseGraph(
  graph: ReadonlyMap<string, readonly string[]>,
  nodes: ReadonlySet<string>,
): Map<string, string[]> {
  const reversed = new Map([...nodes].map((node) => [node, [] as string[]]));
  for (const [source, targets] of graph) {
    for (const target of targets) {
      reversed.get(target)?.push(source);
    }
  }
  return reversed;
}

function collectComponent(
  start: string,
  reversed: ReadonlyMap<string, readonly string[]>,
  assigned: Set<string>,
): Set<string> {
  const component = new Set<string>();
  const pending = [start];
  assigned.add(start);
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) {
      continue;
    }
    component.add(node);
    for (const source of reversed.get(node) ?? []) {
      if (!assigned.has(source)) {
        assigned.add(source);
        pending.push(source);
      }
    }
  }
  return component;
}

export function findReferenceCycleComponents(
  graph: ReadonlyMap<string, readonly string[]>,
): Map<string, ReadonlySet<string>> {
  const nodes = graphNodes(graph);
  const order = finishingOrder(graph, nodes);
  const reversed = reverseGraph(graph, nodes);
  const assigned = new Set<string>();
  const cyclic = new Map<string, ReadonlySet<string>>();
  for (const start of order.reverse()) {
    if (assigned.has(start)) {
      continue;
    }
    const component = collectComponent(start, reversed, assigned);
    const isCycle =
      component.size > 1 || (graph.get(start) ?? []).includes(start);
    if (isCycle) {
      for (const node of component) {
        cyclic.set(node, component);
      }
    }
  }
  return cyclic;
}

export function findReferenceCycleNodes(
  graph: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  return new Set(findReferenceCycleComponents(graph).keys());
}
