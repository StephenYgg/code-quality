export type Comparator<T> = (left: T, right: T) => number;

function siftUpMaxHeap<T>(items: T[], compare: Comparator<T>): void {
  let index = items.length - 1;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    const item = items[index];
    const parent = items[parentIndex];
    if (
      item === undefined ||
      parent === undefined ||
      compare(item, parent) <= 0
    ) {
      return;
    }
    items[index] = parent;
    items[parentIndex] = item;
    index = parentIndex;
  }
}

function siftDownMaxHeap<T>(items: T[], compare: Comparator<T>): void {
  let index = 0;
  while (index < items.length) {
    const leftIndex = index * 2 + 1;
    const rightIndex = leftIndex + 1;
    let largestIndex = index;
    const largest = items[largestIndex];
    const left = items[leftIndex];
    if (
      largest !== undefined &&
      left !== undefined &&
      compare(left, largest) > 0
    ) {
      largestIndex = leftIndex;
    }
    const candidate = items[largestIndex];
    const right = items[rightIndex];
    if (
      candidate !== undefined &&
      right !== undefined &&
      compare(right, candidate) > 0
    ) {
      largestIndex = rightIndex;
    }
    if (largestIndex === index) {
      return;
    }
    const item = items[index];
    const replacement = items[largestIndex];
    if (item === undefined || replacement === undefined) {
      return;
    }
    items[index] = replacement;
    items[largestIndex] = item;
    index = largestIndex;
  }
}

export function retainSmallest<T>(
  items: T[],
  item: T,
  maximum: number,
  compare: Comparator<T>,
): T | undefined {
  if (maximum === 0) {
    return item;
  }
  if (items.length < maximum) {
    items.push(item);
    siftUpMaxHeap(items, compare);
    return undefined;
  }
  const largest = items[0];
  if (largest === undefined || compare(item, largest) >= 0) {
    return item;
  }
  items[0] = item;
  siftDownMaxHeap(items, compare);
  return largest;
}

interface IndexedHeapEntry<T> {
  readonly value: T;
  minimumIndex: number;
  maximumIndex: number;
}

type HeapIndex = "minimumIndex" | "maximumIndex";

function hasPriority<T>(
  left: IndexedHeapEntry<T>,
  right: IndexedHeapEntry<T>,
  compare: Comparator<T>,
  maximumFirst: boolean,
): boolean {
  const order = compare(left.value, right.value);
  return maximumFirst ? order > 0 : order < 0;
}

function swapIndexedEntries<T>(
  heap: IndexedHeapEntry<T>[],
  leftIndex: number,
  rightIndex: number,
  indexKey: HeapIndex,
): void {
  const left = heap[leftIndex];
  const right = heap[rightIndex];
  if (left === undefined || right === undefined) {
    return;
  }
  heap[leftIndex] = right;
  heap[rightIndex] = left;
  right[indexKey] = leftIndex;
  left[indexKey] = rightIndex;
}

function siftUpIndexedHeap<T>(
  heap: IndexedHeapEntry<T>[],
  startIndex: number,
  indexKey: HeapIndex,
  compare: Comparator<T>,
  maximumFirst: boolean,
): void {
  let index = startIndex;
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2);
    const entry = heap[index];
    const parent = heap[parentIndex];
    if (
      entry === undefined ||
      parent === undefined ||
      !hasPriority(entry, parent, compare, maximumFirst)
    ) {
      return;
    }
    swapIndexedEntries(heap, index, parentIndex, indexKey);
    index = parentIndex;
  }
}

function siftDownIndexedHeap<T>(
  heap: IndexedHeapEntry<T>[],
  startIndex: number,
  indexKey: HeapIndex,
  compare: Comparator<T>,
  maximumFirst: boolean,
): void {
  let index = startIndex;
  while (index < heap.length) {
    const leftIndex = index * 2 + 1;
    const rightIndex = leftIndex + 1;
    let priorityIndex = index;
    const current = heap[priorityIndex];
    const left = heap[leftIndex];
    if (
      current !== undefined &&
      left !== undefined &&
      hasPriority(left, current, compare, maximumFirst)
    ) {
      priorityIndex = leftIndex;
    }
    const priority = heap[priorityIndex];
    const right = heap[rightIndex];
    if (
      priority !== undefined &&
      right !== undefined &&
      hasPriority(right, priority, compare, maximumFirst)
    ) {
      priorityIndex = rightIndex;
    }
    if (priorityIndex === index) {
      return;
    }
    swapIndexedEntries(heap, index, priorityIndex, indexKey);
    index = priorityIndex;
  }
}

function removeIndexedEntry<T>(
  heap: IndexedHeapEntry<T>[],
  index: number,
  indexKey: HeapIndex,
  compare: Comparator<T>,
  maximumFirst: boolean,
): void {
  const last = heap.pop();
  if (last === undefined || index === heap.length) {
    return;
  }
  heap[index] = last;
  last[indexKey] = index;
  const parentIndex = Math.floor((index - 1) / 2);
  const parent = heap[parentIndex];
  if (
    index > 0 &&
    parent !== undefined &&
    hasPriority(last, parent, compare, maximumFirst)
  ) {
    siftUpIndexedHeap(heap, index, indexKey, compare, maximumFirst);
  } else {
    siftDownIndexedHeap(heap, index, indexKey, compare, maximumFirst);
  }
}

export class BoundedMinPriorityQueue<T> {
  readonly #compare: Comparator<T>;
  readonly #minimumHeap: IndexedHeapEntry<T>[] = [];
  readonly #maximumHeap: IndexedHeapEntry<T>[] = [];
  #maximum: number;

  constructor(maximum: number, compare: Comparator<T>) {
    this.#maximum = maximum;
    this.#compare = compare;
  }

  get size(): number {
    return this.#minimumHeap.length;
  }

  setMaximum(maximum: number): T[] {
    this.#maximum = maximum;
    const omitted: T[] = [];
    while (this.size > maximum) {
      const largest = this.#maximumHeap[0];
      if (largest === undefined) {
        break;
      }
      omitted.push(largest.value);
      this.#remove(largest);
    }
    return omitted;
  }

  retain(item: T): T | undefined {
    if (this.#maximum === 0) {
      return item;
    }
    if (this.size < this.#maximum) {
      this.#add(item);
      return undefined;
    }
    const largest = this.#maximumHeap[0];
    if (largest === undefined || this.#compare(item, largest.value) >= 0) {
      return item;
    }
    const omitted = largest.value;
    this.#remove(largest);
    this.#add(item);
    return omitted;
  }

  popMinimum(): T | undefined {
    const smallest = this.#minimumHeap[0];
    if (smallest === undefined) {
      return undefined;
    }
    this.#remove(smallest);
    return smallest.value;
  }

  #add(value: T): void {
    const entry: IndexedHeapEntry<T> = {
      value,
      minimumIndex: this.#minimumHeap.length,
      maximumIndex: this.#maximumHeap.length,
    };
    this.#minimumHeap.push(entry);
    this.#maximumHeap.push(entry);
    siftUpIndexedHeap(
      this.#minimumHeap,
      entry.minimumIndex,
      "minimumIndex",
      this.#compare,
      false,
    );
    siftUpIndexedHeap(
      this.#maximumHeap,
      entry.maximumIndex,
      "maximumIndex",
      this.#compare,
      true,
    );
  }

  #remove(entry: IndexedHeapEntry<T>): void {
    removeIndexedEntry(
      this.#minimumHeap,
      entry.minimumIndex,
      "minimumIndex",
      this.#compare,
      false,
    );
    removeIndexedEntry(
      this.#maximumHeap,
      entry.maximumIndex,
      "maximumIndex",
      this.#compare,
      true,
    );
  }
}
