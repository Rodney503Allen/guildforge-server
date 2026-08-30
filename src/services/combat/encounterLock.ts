export class KeyedCombatLock<Key extends string | number = number> {
  private readonly queues = new Map<Key, Promise<void>>();

  async run<T>(key: Key, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.queues.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.queues.get(key) === queued) this.queues.delete(key);
    }
  }
}
