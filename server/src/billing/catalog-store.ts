import { createHash } from "node:crypto";

import type { Database } from "../db.js";
import {
  findModel,
  loadCatalog,
  type Capability,
  type CatalogEntry,
} from "./catalog.js";

type CatalogRelease = {
  id: number;
  contentHash: string;
  createdAt: number;
  activatedAt: number;
};

type ReleaseRow = {
  id: number;
  content_hash: string;
  created_at: number;
};

type StateRow = { active_release_id: number; updated_at: number };

export class CatalogStore {
  readonly entries: CatalogEntry[];
  readonly release: CatalogRelease;

  constructor(
    db: Database,
    raw: string,
    now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    const configured = loadCatalog(raw);
    const catalogJson = canonicalCatalogJson(configured);
    const contentHash = createHash("sha256").update(catalogJson).digest("hex");
    const activated = activateConfiguredCatalog(
      db,
      configured,
      catalogJson,
      contentHash,
      now(),
    );
    this.entries = readEntries(db, activated.release.id);
    this.release = {
      id: activated.release.id,
      contentHash: activated.release.content_hash,
      createdAt: activated.release.created_at,
      activatedAt: activated.activatedAt,
    };
  }

  find(modelId: string, capability: Capability) {
    return findModel(this.entries, modelId, capability);
  }

  list() {
    return this.entries;
  }
}

function activateConfiguredCatalog(
  db: Database,
  entries: CatalogEntry[],
  catalogJson: string,
  contentHash: string,
  now: number,
) {
  return db.transaction(() => {
    let release = db
      .prepare(
        "SELECT id, content_hash, created_at FROM model_catalog_releases WHERE content_hash = ?",
      )
      .get(contentHash) as ReleaseRow | undefined;
    const isNewRelease = !release;
    if (!release) {
      assertPriceVersionsAreImmutable(db, entries);
      const result = db
        .prepare(
          "INSERT INTO model_catalog_releases (content_hash, catalog_json, created_at) VALUES (?, ?, ?)",
        )
        .run(contentHash, catalogJson, now);
      release = {
        id: Number(result.lastInsertRowid),
        content_hash: contentHash,
        created_at: now,
      };
      const insertEntry = db.prepare(
        "INSERT INTO model_catalog_entries (release_id, model_id, capability, provider, base_url, provider_model, price_version, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const entry of entries)
        insertEntry.run(
          release.id,
          entry.id,
          entry.capability,
          entry.provider,
          entry.baseUrl,
          entry.model || null,
          entry.priceVersion,
          entry.price,
        );
    }

    const state = db
      .prepare(
        "SELECT active_release_id, updated_at FROM model_catalog_state WHERE singleton = 1",
      )
      .get() as StateRow | undefined;
    if (!state) {
      db.prepare(
        "INSERT INTO model_catalog_state (singleton, active_release_id, updated_at) VALUES (1, ?, ?)",
      ).run(release.id, now);
      db.prepare(
        "INSERT INTO model_catalog_events (release_id, previous_release_id, event_type, source, created_at) VALUES (?, NULL, ?, 'startup_config', ?)",
      ).run(release.id, "published", now);
      return { release, activatedAt: now };
    }
    if (state.active_release_id !== release.id) {
      db.prepare(
        "UPDATE model_catalog_state SET active_release_id = ?, updated_at = ? WHERE singleton = 1",
      ).run(release.id, now);
      db.prepare(
        "INSERT INTO model_catalog_events (release_id, previous_release_id, event_type, source, created_at) VALUES (?, ?, ?, 'startup_config', ?)",
      ).run(
        release.id,
        state.active_release_id,
        isNewRelease ? "published" : "reactivated",
        now,
      );
      return { release, activatedAt: now };
    }
    return { release, activatedAt: state.updated_at };
  })();
}

function assertPriceVersionsAreImmutable(
  db: Database,
  entries: CatalogEntry[],
) {
  const previousPrice = db.prepare(
    "SELECT price FROM model_catalog_entries WHERE model_id = ? AND price_version = ? LIMIT 1",
  );
  for (const entry of entries) {
    const previous = previousPrice.get(entry.id, entry.priceVersion) as
      { price: number } | undefined;
    if (previous && previous.price !== entry.price)
      throw new Error(
        `Price for model ${entry.id} changed without a new priceVersion`,
      );
  }
}

function readEntries(db: Database, releaseId: number) {
  const rows = db
    .prepare(
      "SELECT model_id, capability, provider, base_url, provider_model, price_version, price FROM model_catalog_entries WHERE release_id = ? ORDER BY model_id",
    )
    .all(releaseId) as Array<{
    model_id: string;
    capability: CatalogEntry["capability"];
    provider: CatalogEntry["provider"];
    base_url: string;
    provider_model: string | null;
    price_version: string;
    price: number;
  }>;
  return rows.map((row) => ({
    id: row.model_id,
    capability: row.capability,
    provider: row.provider,
    baseUrl: row.base_url,
    ...(row.provider_model ? { model: row.provider_model } : {}),
    priceVersion: row.price_version,
    price: row.price,
  }));
}

function canonicalCatalogJson(entries: CatalogEntry[]) {
  return JSON.stringify(
    [...entries]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({
        id: entry.id,
        capability: entry.capability,
        provider: entry.provider,
        baseUrl: entry.baseUrl,
        ...(entry.model ? { model: entry.model } : {}),
        priceVersion: entry.priceVersion,
        price: entry.price,
      })),
  );
}
