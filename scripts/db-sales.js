/*
 * Gnoke Gas — db-sales.js
 * Copyright (C) 2026 Edmund Sparrow <edmundsparrow@gmail.com>
 * Licensed under GNU GPL v3
 *
 * Data access layer for:
 *   - Today's day record (auto-create with carry-forward)
 *   - Sales line items (real-time insert / update / delete)
 *   - Day totals
 *   - History
 *   - Company profile
 *   - Settings
 *
 * Depends on db-core.js
 */

const DBSales = (() => {

  // ── Day management ─────────────────────────────────────────────────────────

  /**
   * Get today's day record. Creates it if it doesn't exist.
   * On creation, carries forward:
   *   - opening_stock = yesterday's closing balance (opening - kg sold)
   *   - unit_price    = yesterday's unit price
   * If no previous day exists, both default to 0.
   *
   * @returns {Object} day row — { id, date, opening_stock, unit_price, ... }
   */
  function getOrCreateToday() {
    const date = DB.today();

    // Check if today already exists
    const existing = DB.query(
      'SELECT * FROM days WHERE date = ?', [date]
    )[0];
    if (existing) return existing;

    // Carry forward from the most recent previous day
    const prev = DB.query(`
      SELECT
        d.opening_stock,
        d.unit_price,
        COALESCE(SUM(s.kg), 0) AS kg_sold
      FROM days d
      LEFT JOIN sales s ON s.day_id = d.id
      WHERE d.date < ?
      GROUP BY d.id
      ORDER BY d.date DESC
      LIMIT 1
    `, [date])[0];

    const opening_stock = prev
      ? Math.max(0, prev.opening_stock - prev.kg_sold)
      : 0;
    const unit_price = prev ? prev.unit_price : 0;

    // Insert today's record synchronously via the internal run
    // We need the new id immediately so we use exec directly
    DB.query(
      `INSERT INTO days (date, opening_stock, unit_price) VALUES (?, ?, ?)`,
      [date, opening_stock, unit_price]
    );
    // Flush to IndexedDB via a no-op run
    // (direct exec above doesn't persist — force persist via run)
    _persist(date, opening_stock, unit_price);

    return DB.query('SELECT * FROM days WHERE date = ?', [date])[0];
  }

  // Internal: persist the newly inserted day row
  // We use a synchronous path to avoid async in getOrCreateToday
  function _persist(date, opening_stock, unit_price) {
    // Already inserted above via DB.query which calls _db.exec directly
    // Just mark dirty and schedule persist
    DB.run(
      `UPDATE days SET unit_price = ? WHERE date = ?`,
      [unit_price, date]
    ).catch(() => {});
  }

  /**
   * Get a day record by date string (YYYY-MM-DD).
   */
  function getDay(date) {
    return DB.query('SELECT * FROM days WHERE date = ?', [date])[0] || null;
  }

  /**
   * Update the unit price for a day. Triggers price recalc on all sales.
   */
  async function updateUnitPrice(dayId, unitPrice) {
    // Update the day row
    await DB.run(
      'UPDATE days SET unit_price = ? WHERE id = ?',
      [unitPrice, dayId]
    );
    // Recalculate price on every sale for this day
    await DB.run(
      'UPDATE sales SET price = ROUND(kg * ?, 2) WHERE day_id = ?',
      [unitPrice, dayId]
    );
  }

  /**
   * Update opening stock for a day.
   */
  async function updateOpeningStock(dayId, openingStock) {
    await DB.run(
      'UPDATE days SET opening_stock = ? WHERE id = ?',
      [openingStock, dayId]
    );
  }

  // ── Sales line items ───────────────────────────────────────────────────────

  /**
   * Get all sales for a day, ordered by seq.
   */
  function getSalesForDay(dayId) {
    return DB.query(
      'SELECT * FROM sales WHERE day_id = ? ORDER BY seq ASC',
      [dayId]
    );
  }

  /**
   * Add a new sale row to a day.
   * seq is auto-assigned as max(seq) + 1 for that day.
   *
   * @returns {{ id, seq }} the new sale's id and seq number
   */
  async function addSale(dayId, { kg = 0, price = 0, comments = '' } = {}) {
    const seqResult = DB.query(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM sales WHERE day_id = ?',
      [dayId]
    )[0];
    const seq = seqResult?.next_seq || 1;

    const result = await DB.run(
      `INSERT INTO sales (day_id, seq, kg, price, comments)
       VALUES (?, ?, ?, ?, ?)`,
      [dayId, seq, kg, price, comments]
    );
    return { id: result.lastInsertRowid, seq };
  }

  /**
   * Update an existing sale row.
   * Pass only the fields you want to change.
   */
  async function updateSale(saleId, { kg, price, comments }) {
    // Build partial update — only set fields that were provided
    const parts  = [];
    const params = [];

    if (kg       !== undefined) { parts.push('kg = ?');       params.push(kg); }
    if (price    !== undefined) { parts.push('price = ?');    params.push(price); }
    if (comments !== undefined) { parts.push('comments = ?'); params.push(comments); }

    if (!parts.length) return;
    params.push(saleId);

    await DB.run(
      `UPDATE sales SET ${parts.join(', ')} WHERE id = ?`,
      params
    );
  }

  /**
   * Delete a sale row and resequence remaining rows.
   */
  async function deleteSale(saleId, dayId) {
    await DB.transaction(async tx => {
      tx('DELETE FROM sales WHERE id = ?', [saleId]);
      // Resequence remaining rows for this day
      const rows = DB.query(
        'SELECT id FROM sales WHERE day_id = ? ORDER BY seq ASC',
        [dayId]
      );
      rows.forEach((row, i) => {
        tx('UPDATE sales SET seq = ? WHERE id = ?', [i + 1, row.id]);
      });
    });
  }

  // ── Totals ─────────────────────────────────────────────────────────────────

  /**
   * Get aggregated totals for a day.
   * @returns {{ kg_sum, price_sum, balance, opening_stock, unit_price }}
   */
  function getDayTotals(dayId) {
    const result = DB.query(`
      SELECT
        d.opening_stock,
        d.unit_price,
        COALESCE(SUM(s.kg),    0) AS kg_sum,
        COALESCE(SUM(s.price), 0) AS price_sum,
        d.opening_stock - COALESCE(SUM(s.kg), 0) AS balance
      FROM days d
      LEFT JOIN sales s ON s.day_id = d.id
      WHERE d.id = ?
      GROUP BY d.id
    `, [dayId])[0];

    return result || {
      opening_stock: 0, unit_price: 0,
      kg_sum: 0, price_sum: 0, balance: 0
    };
  }

  // ── History ────────────────────────────────────────────────────────────────

  /**
   * Get all days with their totals, most recent first.
   * Used by the history page.
   */
  function getHistory() {
    return DB.query(`
      SELECT
        d.id,
        d.date,
        d.opening_stock,
        d.unit_price,
        COALESCE(SUM(s.kg),    0)                       AS kg_sum,
        COALESCE(SUM(s.price), 0)                       AS price_sum,
        d.opening_stock - COALESCE(SUM(s.kg), 0)        AS balance,
        COUNT(s.id)                                     AS sale_count
      FROM days d
      LEFT JOIN sales s ON s.day_id = d.id
      GROUP BY d.id
      ORDER BY d.date DESC
    `);
  }

  /**
   * Delete a day and all its sales (CASCADE handles the sales rows).
   */
  async function deleteDay(dayId) {
    await DB.run('DELETE FROM days WHERE id = ?', [dayId]);
  }

  // ── Company profile ────────────────────────────────────────────────────────

  function getCompany() {
    return DB.query('SELECT * FROM company WHERE id = 1')[0] || null;
  }

  async function saveCompany({ name = '', phone = '', address = '' }) {
    await DB.run(
      `UPDATE company
       SET name = ?, phone = ?, address = ?, updated_at = datetime('now','localtime')
       WHERE id = 1`,
      [name, phone, address]
    );
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  function getSetting(key) {
    const row = DB.query(
      'SELECT value FROM settings WHERE key = ?', [key]
    )[0];
    return row ? row.value : null;
  }

  async function saveSetting(key, value) {
    await DB.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    // Day
    getOrCreateToday,
    getDay,
    updateUnitPrice,
    updateOpeningStock,
    // Sales
    getSalesForDay,
    addSale,
    updateSale,
    deleteSale,
    // Totals
    getDayTotals,
    // History
    getHistory,
    deleteDay,
    // Company
    getCompany,
    saveCompany,
    // Settings
    getSetting,
    saveSetting,
  };

})();
