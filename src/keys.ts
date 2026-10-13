export class KeyPool {
  private keys: string[];
  private dead = new Map<string, number>();
  private i = 0;

  constructor(csv: string | undefined) {
    this.keys = (csv ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  }

  /** Adds keys that are not in the pool yet (keys submitted at runtime). */
  add(list: string[]) {
    for (const k of list) if (!this.keys.includes(k)) this.keys.push(k);
  }

  get size() {
    return this.keys.length;
  }

  /** Keys in rotation order, skipping ones on cooldown. */
  live(): string[] {
    const now = Date.now();
    const n = this.keys.length;
    const out: string[] = [];
    for (let k = 0; k < n; k++) {
      const key = this.keys[(this.i + k) % n];
      if ((this.dead.get(key) ?? 0) <= now) out.push(key);
    }
    this.i = (this.i + 1) % Math.max(n, 1);
    return out;
  }

  cooldown(key: string, ms: number) {
    this.dead.set(key, Date.now() + ms);
  }
}
