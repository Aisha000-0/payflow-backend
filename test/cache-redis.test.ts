import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createCache, RedisCache } from "../src/lib/cache.ts";
import { MerchantSummaryCache } from "../src/routes/merchants.ts";
import { TokenMetadataService, type TokenReader } from "../src/lib/tokens.ts";
import type { MerchantSummary, TokenMetadata } from "../src/routes/types.ts";

const REDIS_URL = process.env.REDIS_URL;
const maybe = REDIS_URL ? test : test.skip;

maybe("redis cache integration", async (t) => {
  const prefix = `payflow-test:${randomUUID()}`;
  const cache = new RedisCache<string>(REDIS_URL!, prefix);
  t.after(async () => {
    await cache.clear();
    await cache.close();
  });

  await t.test("set/get/delete/clear", async () => {
    assert.equal(await cache.get("missing"), undefined);
    await cache.set("k1", "v1", 60_000);
    assert.equal(await cache.get("k1"), "v1");
    await cache.delete("k1");
    assert.equal(await cache.get("k1"), undefined);
    await cache.set("k2", "v2", 60_000);
    await cache.clear();
    assert.equal(await cache.get("k2"), undefined);
  });

  await t.test("prefix invalidation deletes scoped keys", async () => {
    await cache.set("merchant", "base", 60_000);
    await cache.set("merchant:TOKEN", "scoped", 60_000);
    await cache.set("merchant2", "other", 60_000);
    await cache.delete("merchant");
    assert.equal(await cache.get("merchant"), undefined);
    assert.equal(await cache.get("merchant:TOKEN"), undefined);
    assert.equal(await cache.get("merchant2"), "other");
  });
});

maybe("merchant summary cache works with redis", async (t) => {
  const prefix = `payflow-test:${randomUUID()}:merchant`;
  const store = new RedisCache<MerchantSummary>(REDIS_URL!, prefix);
  const cache = new MerchantSummaryCache(store);
  t.after(async () => {
    await cache.clear();
    await store.close();
  });

  const summary: MerchantSummary = {
    merchant: "G".padEnd(56, "A"),
    activeMandates: 1,
    totalCollected: "10",
    chargeCount: 1,
    mrr: "1",
    arr: "12",
    tokens: [],
  };
  assert.equal(await cache.get(summary.merchant), undefined);
  await cache.set(summary.merchant, summary);
  assert.deepEqual(await cache.get(summary.merchant), summary);
  await cache.invalidate(summary.merchant);
  assert.equal(await cache.get(summary.merchant), undefined);
});

maybe("token metadata cache works with redis store", async (t) => {
  const prefix = `payflow-test:${randomUUID()}:token`;
  const store = new RedisCache<TokenMetadata>(REDIS_URL!, prefix);
  let calls = 0;
  const reader: TokenReader = async (token) => {
    calls += 1;
    return { token, symbol: "TOK", name: "Token", decimals: 7 };
  };
  const svc = new TokenMetadataService(reader, { store, ttlMs: 60_000 });
  t.after(async () => {
    await store.clear();
    await store.close();
  });

  const token = "C".padEnd(56, "A");
  const first = await svc.fetch(token);
  const second = await svc.fetch(token);
  assert.equal(calls, 1);
  assert.deepEqual(second, first);

  // New service instance should hit Redis, not reader.
  const svc2 = new TokenMetadataService(reader, { store, ttlMs: 60_000 });
  const third = await svc2.fetch(token);
  assert.equal(calls, 1);
  assert.deepEqual(third, first);
});

test("createCache defaults to memory without REDIS_URL", async () => {
  const cache = createCache<string>();
  await cache.set("k", "v");
  assert.equal(await cache.get("k"), "v");
  await cache.close();
});
