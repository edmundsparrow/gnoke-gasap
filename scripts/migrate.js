/*
 * Gnoke Gas — migrate.js
 * Copyright (C) 2026 Edmund Sparrow <edmundsparrow@gmail.com>
 * Licensed under GNU GPL v3
 *
 * One-time migration from the old gasap LocalForage storage
 * into the new Gnoke Gas SQLite database.
 *
 * Old storage:
 *   LocalForage — name:'salesApp', storeName:'salesData'
 *   Keys:
 *     dailySales_YYYY-MM-DD  → CSV string (historical days)
 *     salesChunk_0, _1 ...   → array of {gas, price, comments} (today's live data)
 *     salesMeta              → {unitPrice, newStock, lastUpdated}
 *
 * Depends on: sql.js, db-core.js, db-sales.js, localforage (cdn)
 */

const Migrate = (() => {

  const MIGRATION_DONE_KEY = 'migration_v1_done';

  // ── Check if migration has already run ────────────────────────────────────

  function isDone() {
    return DBSales.getSetting(MIGRATION_DONE_KEY) === '1';
  }

  // ── Open old LocalForage store ────────────────────────────────────────────

  function _getOldStore() {
    return localforage.createInstance({
      name:      'salesApp',
      storeName: 'salesData',
    });
  }

  // ── Parse one CSV string → array of sale objects ──────────────────────────
  //
  // CSV format (from original saveDailyCSV):
  //   S/NO,GAS,PRICE,COMMENTS,UNIT,BALANCE
  //   1,5,6250,Paid,1250,115.00
  //
  // Returns: { unitPrice, openingStock, sales: [{seq,kg,price,comments}] }

  function _parseCSV(csvString) {
    const lines = csvString
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('S/NO')); // skip header and empty lines

    if (!lines.length) return null;

    const sales      = [];
    let   unitPrice  = 0;
    let   openStock  = 0;
    let   firstRow   = true;

    for (const line of lines) {
      // Split by comma but respect quoted fields
      const cols = line.split(',');
      if (cols.length < 4) continue;

      const seq      = parseInt(cols[0])   || 0;
      const kg       = parseFloat(cols[1]) || 0;
      const price    = parseFloat(cols[2]) || 0;
      const comments = (cols[3] || '').trim();
      const unit     = parseFloat(cols[4]) || 0;
      const balance  = parseFloat(cols[5]) || 0;

      if (unit > 0)  unitPrice = unit;

      // Derive opening stock from first row:
      // openingStock = balance_after_row1 + kg_row1
      if (firstRow && kg > 0) {
        openStock = balance + kg;
        firstRow  = false;
      }

      if (kg > 0) {
        sales.push({ seq, kg, price, comments });
      }
    }

    return { unitPrice, openingStock: openStock, sales };
  }

  // ── Run the migration ─────────────────────────────────────────────────────

  async function run(onProgress) {

    const log = msg => {
      console.log('[Migrate]', msg);
      if (onProgress) onProgress(msg);
    };

    if (isDone()) {
      log('Migration already completed — skipping.');
      return { skipped: true };
    }

    const store = _getOldStore();

    // 1. Gather all keys
    let allKeys;
    try {
      allKeys = await store.keys();
    } catch (e) {
      log('Old store not found — nothing to migrate.');
      await DBSales.saveSetting(MIGRATION_DONE_KEY, '1');
      return { migrated: 0, skipped: true };
    }

    if (!allKeys || !allKeys.length) {
      log('Old store is empty — nothing to migrate.');
      await DBSales.saveSetting(MIGRATION_DONE_KEY, '1');
      return { migrated: 0 };
    }

    log(`Found ${allKeys.length} keys in old store.`);

    // 2. Separate key types
    const dailyKeys = allKeys
      .filter(k => k.startsWith('dailySales_'))
      .sort(); // ascending date order

    const chunkKeys = allKeys
      .filter(k => k.startsWith('salesChunk_'))
      .sort((a, b) => {
        const na = parseInt(a.replace('salesChunk_', ''));
        const nb = parseInt(b.replace('salesChunk_', ''));
        return na - nb;
      });

    log(`Daily records: ${dailyKeys.length} · Chunk keys: ${chunkKeys.length}`);

    let migratedDays  = 0;
    let migratedSales = 0;
    let skippedDays   = 0;

    // 3. Migrate historical daily records
    for (const key of dailyKeys) {
      const date = key.replace('dailySales_', '');

      // Skip if already exists in new DB (idempotent)
      const existing = DBSales.getDay(date);
      if (existing) {
        log(`Skipping ${date} — already in new DB.`);
        skippedDays++;
        continue;
      }

      const csv = await store.getItem(key);
      if (!csv || typeof csv !== 'string') {
        log(`Skipping ${date} — empty or invalid CSV.`);
        continue;
      }

      const parsed = _parseCSV(csv);
      if (!parsed || !parsed.sales.length) {
        log(`Skipping ${date} — no valid sales rows.`);
        continue;
      }

      // Insert day row
      const dayResult = await DB.run(
        `INSERT OR IGNORE INTO days (date, opening_stock, unit_price)
         VALUES (?, ?, ?)`,
        [date, parsed.openingStock, parsed.unitPrice]
      );

      const dayId = dayResult.lastInsertRowid;
      if (!dayId) {
        log(`Failed to insert day ${date}`);
        continue;
      }

      // Insert sales rows
      for (const s of parsed.sales) {
        await DB.run(
          `INSERT INTO sales (day_id, seq, kg, price, comments)
           VALUES (?, ?, ?, ?, ?)`,
          [dayId, s.seq, s.kg, s.price, s.comments]
        );
        migratedSales++;
      }

      migratedDays++;
      log(`Migrated ${date} — ${parsed.sales.length} entries`);
    }

    // 4. Migrate today's live chunks if present (salesChunk_*)
    if (chunkKeys.length) {
      const meta = await store.getItem('salesMeta');
      const todayDate = DB.today();

      // Don't overwrite if today already exists from daily records
      const todayExists = DBSales.getDay(todayDate);

      if (!todayExists) {
        const unitPrice   = parseFloat(meta?.unitPrice)  || 0;
        const openStock   = parseFloat(meta?.newStock)   || 0;

        // Combine all chunks
        let allSales = [];
        for (const key of chunkKeys) {
          const chunk = await store.getItem(key);
          if (Array.isArray(chunk)) allSales = [...allSales, ...chunk];
        }

        // Filter meaningful rows
        const validSales = allSales.filter(s => parseFloat(s.gas) > 0);

        if (validSales.length) {
          const dayResult = await DB.run(
            `INSERT OR IGNORE INTO days (date, opening_stock, unit_price)
             VALUES (?, ?, ?)`,
            [todayDate, openStock, unitPrice]
          );
          const dayId = dayResult.lastInsertRowid;

          if (dayId) {
            for (let i = 0; i < validSales.length; i++) {
              const s = validSales[i];
              const kg    = parseFloat(s.gas)   || 0;
              const price = parseFloat(s.price) || kg * unitPrice;
              await DB.run(
                `INSERT INTO sales (day_id, seq, kg, price, comments)
                 VALUES (?, ?, ?, ?, ?)`,
                [dayId, i + 1, kg, price, s.comments || '']
              );
              migratedSales++;
            }
            migratedDays++;
            log(`Migrated today (${todayDate}) from live chunks — ${validSales.length} entries`);
          }
        }
      }
    }

    // 5. Mark migration complete
    await DBSales.saveSetting(MIGRATION_DONE_KEY, '1');

    const summary = {
      migrated:    migratedDays,
      sales:       migratedSales,
      skipped:     skippedDays,
    };

    log(`Done — ${migratedDays} days, ${migratedSales} sales migrated.`);
    return summary;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return { isDone, run };

})();
