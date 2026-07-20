const MAX_PUBLICATION_LANES = 128;
const MAX_WAITERS_PER_LANE = 16;

interface PublicationLane {
  tail: Promise<void>;
  waiters: number;
}

const lanes = new Map<string, PublicationLane>();

export class PublicationLaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationLaneError";
  }
}

export async function withPublicationLane<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lane = lanes.get(key);
  if (lane === undefined) {
    if (lanes.size >= MAX_PUBLICATION_LANES) {
      throw new PublicationLaneError("Publication concurrency limit reached");
    }
    lane = { tail: Promise.resolve(), waiters: 0 };
    lanes.set(key, lane);
  }
  if (lane.waiters >= MAX_WAITERS_PER_LANE) {
    throw new PublicationLaneError("Publication target queue limit reached");
  }

  const previous = lane.tail;
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  lane.tail = previous.then(() => turn);
  lane.waiters += 1;
  await previous;
  try {
    return await operation();
  } finally {
    release();
    lane.waiters -= 1;
    if (lane.waiters === 0) lanes.delete(key);
  }
}
