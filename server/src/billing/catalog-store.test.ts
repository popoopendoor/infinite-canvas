import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db.js";
import { CatalogStore } from "./catalog-store.js";

const firstCatalog = JSON.stringify([
  {
    id: "image-basic",
    capability: "image",
    provider: "openai",
    baseUrl: "https://api.example.test",
    model: "image-basic",
    priceVersion: "2026-09-07",
    price: 3,
  },
]);

test("catalog releases are immutable and can be reactivated by a prior config", () => {
  const db = openDatabase(":memory:");
  const first = new CatalogStore(db, firstCatalog, () => 100);
  const unchanged = new CatalogStore(db, firstCatalog, () => 200);
  assert.equal(unchanged.release.id, first.release.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM model_catalog_releases").get()
      .count,
    1,
  );

  const second = new CatalogStore(
    db,
    firstCatalog
      .replace('"price":3', '"price":4')
      .replace("2026-09-07", "2026-09-08"),
    () => 300,
  );
  assert.notEqual(second.release.id, first.release.id);
  assert.equal(second.find("image-basic", "image").price, 4);

  const restored = new CatalogStore(db, firstCatalog, () => 400);
  assert.equal(restored.release.id, first.release.id);
  assert.equal(restored.find("image-basic", "image").price, 3);
  assert.deepEqual(
    db
      .prepare(
        "SELECT event_type, previous_release_id FROM model_catalog_events ORDER BY id",
      )
      .all(),
    [
      { event_type: "published", previous_release_id: null },
      { event_type: "published", previous_release_id: first.release.id },
      { event_type: "reactivated", previous_release_id: second.release.id },
    ],
  );
  db.close();
});

test("catalog ordering does not create a second release", () => {
  const db = openDatabase(":memory:");
  const first = new CatalogStore(
    db,
    JSON.stringify([
      {
        id: "z-model",
        capability: "text",
        provider: "openai",
        baseUrl: "https://api.example.test",
        priceVersion: "v1",
        price: 1,
      },
      {
        id: "a-model",
        capability: "audio",
        provider: "openai",
        baseUrl: "https://api.example.test",
        priceVersion: "v1",
        price: 2,
      },
    ]),
  );
  const reordered = new CatalogStore(
    db,
    JSON.stringify([
      {
        id: "a-model",
        capability: "audio",
        provider: "openai",
        baseUrl: "https://api.example.test",
        priceVersion: "v1",
        price: 2,
      },
      {
        id: "z-model",
        capability: "text",
        provider: "openai",
        baseUrl: "https://api.example.test",
        priceVersion: "v1",
        price: 1,
      },
    ]),
  );
  assert.equal(reordered.release.id, first.release.id);
  db.close();
});

test("catalog rejects a price change that reuses the same price version", () => {
  const db = openDatabase(":memory:");
  new CatalogStore(db, firstCatalog);

  assert.throws(
    () => new CatalogStore(db, firstCatalog.replace('"price":3', '"price":4')),
    /changed without a new priceVersion/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM model_catalog_releases").get()
      .count,
    1,
  );
  db.close();
});
