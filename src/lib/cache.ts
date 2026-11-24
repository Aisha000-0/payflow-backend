import { createClient, type RedisClientType } from "redis";
import { logger } from "./logger.ts";

export interface CacheStore<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, ttlMs?: number): Promise<void>;
  /** Delete one key or, when supported, keys matching a prefix. */
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

/** Bounded LRU in-memory cache. Values are JSON-cloned on write/read to
 * keep the same isolation semantics as a remote cache. */
export class MemoryCache<T> implements CacheStore<T> {
  private readonly max: number;
  private readonly map = new Map<string, { value: string; expiresAt: number }>();

  constructor(max = 1_000) {
    this.max = max;
  }

  async get(key: string): Promise<T | undefined> {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return JSON.parse(entry.value) as T;
  }

  async set(key: string, value: T, ttlMs = 30 * 60_000): Promise<void> {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    for (const k of [...this.map.keys()]) {
      if (k === key || k.startsWith(`${key}:`)) this.map.delete(k);
    }
  }

  async clear(): Promise<void> {
    this.map.clear();
  }

  async close(): Promise<void> {}

  get size(): number {
    return this.map.size;
  }
}

export class RedisCache<T> implements CacheStore<T> {
  private readonly client: RedisClientType;
  private readonly prefix: string;
  private readonly ready: Promise<void>;

  constructor(url: string, prefix = "payflow") {
    this.prefix = prefix;
    this.client = createClient({ url });
    this.client.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: { message, name: err instanceof Error ? err.name : "Error" } }, "redis cache error");
    });
    this.ready = this.client.connect().then(() => undefined);
  }

  private k(key: string): string {
    return `${this.prefix}:${key}`;
  }

  private async run<R>(op: string, fn: () => Promise<R>, fallback: R): Promise<R> {
    try {
      await this.ready;
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: { message, name: err instanceof Error ? err.name : "Error" }, op }, "redis cache operation failed");
      return fallback;
    }
  }

  async get(key: string): Promise<T | undefined> {
    return this.run("get", async () => {
      const raw = await this.client.get(this.k(key));
      return raw ? (JSON.parse(raw) as T) : undefined;
    }, undefined);
  }

  async set(key: string, value: T, ttlMs = 30 * 60_000): Promise<void> {
    await this.run("set", async () => {
      await this.client.set(this.k(key), JSON.stringify(value), { PX: Math.max(1, Math.trunc(ttlMs)) });
    }, undefined);
  }

  async delete(key: string): Promise<void> {
    await this.run("delete", async () => {
      const exact = this.k(key);
      const pattern = `${exact}:*`;
      const keys: string[] = [exact];
      for await (const batch of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        if (Array.isArray(batch)) keys.push(...batch);
        else keys.push(batch as unknown as string);
      }
      const unique = [...new Set(keys)];
      if (unique.length > 0) await this.client.del(unique);
    }, undefined);
  }

  async clear(): Promise<void> {
    await this.run("clear", async () => {
      const pattern = `${this.prefix}:*`;
      const keys: string[] = [];
      for await (const batch of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        if (Array.isArray(batch)) keys.push(...batch);
        else keys.push(batch as unknown as string);
      }
      if (keys.length > 0) await this.client.del(keys);
    }, undefined);
  }

  async close(): Promise<void> {
    try {
      await this.ready;
      await this.client.quit();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: { message, name: err instanceof Error ? err.name : "Error" } }, "redis cache close failed");
    }
  }
}

export function createCache<T>(redisUrl?: string, prefix = "payflow"): CacheStore<T> {
  if (redisUrl) return new RedisCache<T>(redisUrl, prefix);
  return new MemoryCache<T>();
}
