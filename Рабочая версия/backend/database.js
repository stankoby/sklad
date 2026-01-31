import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'warehouse.db');

let db = null;
let SQL = null;

async function initDatabase() {
  if (db) return db;
  
  SQL = await initSqlJs();
  
  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  
  // Товары
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      article TEXT,
      barcode TEXT,
      sku TEXT,
      price REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      image_url TEXT,
      meta_href TEXT,
      requires_marking INTEGER DEFAULT 0,
      cell_address TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_products_article ON products(article)`);

  // Доп. штрихкоды (упаковки/варианты). Один товар может иметь несколько штрихкодов.
  db.run(`
    CREATE TABLE IF NOT EXISTS product_barcodes (
      product_id TEXT NOT NULL,
      barcode TEXT NOT NULL,
      PRIMARY KEY (product_id, barcode),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_product_barcodes_barcode ON product_barcodes(barcode)`);


  // Задачи упаковки
  db.run(`
    CREATE TABLE IF NOT EXISTS packing_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source TEXT DEFAULT 'manual',
      marketplace TEXT,
      cluster TEXT,
      days INTEGER,
      status TEXT DEFAULT 'active',
      total_items INTEGER DEFAULT 0,
      packed_items INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      shipment_id TEXT
    )
  `);

  // Позиции задачи упаковки
  db.run(`
    CREATE TABLE IF NOT EXISTS packing_task_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      planned_qty INTEGER NOT NULL,
      scanned_qty INTEGER DEFAULT 0,
      requires_marking INTEGER DEFAULT 0
    )
  `);

  // Короба
  db.run(`
    CREATE TABLE IF NOT EXISTS boxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Позиции в коробах
  db.run(`
    CREATE TABLE IF NOT EXISTS box_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      box_id INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      chestny_znak TEXT UNIQUE,
      scanned_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Заказы поставщикам (из МойСклад)
  db.run(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      name TEXT,
      moment TEXT,
      supplier_name TEXT,
      status TEXT DEFAULT 'pending',
      total_items INTEGER DEFAULT 0,
      meta_href TEXT,
      agent_meta TEXT,
      organization_meta TEXT,
      store_meta TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Позиции заказа поставщику
  db.run(`
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      ordered_qty INTEGER NOT NULL,
      received_qty INTEGER DEFAULT 0
    )
  `);

  // Сессии приемки
  db.run(`
    CREATE TABLE IF NOT EXISTS receiving_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_order_id TEXT,
      name TEXT,
      status TEXT DEFAULT 'active',
      total_ordered INTEGER DEFAULT 0,
      total_received INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      supply_id TEXT,
      enter_id TEXT,
      last_scan_item_id INTEGER,
      last_scan_qty INTEGER,
      last_scan_prev_qty INTEGER
    )
  `);

  // Позиции приемки
  db.run(`
    CREATE TABLE IF NOT EXISTS receiving_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      ordered_qty INTEGER DEFAULT 0,
      received_qty INTEGER DEFAULT 0,
      defect_qty INTEGER DEFAULT 0,
      is_extra INTEGER DEFAULT 0
    )
  `);

  // Журнал действий
  db.run(`
    CREATE TABLE IF NOT EXISTS action_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Статус синхронизации
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_status (
      id INTEGER PRIMARY KEY,
      last_sync TEXT,
      products_count INTEGER DEFAULT 0,
      orders_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'never'
    )
  `);

  db.run(`INSERT OR IGNORE INTO sync_status (id) VALUES (1)`);
  
  saveDatabase();
  return db;
}

function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileSync(DB_PATH, buffer);
  }
}

class Database {
  constructor(sqlDb) {
    this._db = sqlDb;
  }

  prepare(sql) {
    const self = this;
    return {
      run(...params) {
        try {
          const cleanParams = params.map(p => p === undefined ? null : p);
          self._db.run(sql, cleanParams);
          // Get lastInsertRowid BEFORE saveDatabase
          const result = self._db.exec('SELECT last_insert_rowid() as id, changes() as changes');
          const lastId = result[0]?.values[0]?.[0] || 0;
          const changes = result[0]?.values[0]?.[1] || 0;
          saveDatabase();
          console.log('SQL run:', sql.substring(0, 50), '-> lastId:', lastId);
          return { lastInsertRowid: lastId, changes };
        } catch (err) {
          console.error('SQL Error:', err.message, sql, params);
          throw err;
        }
      },
      get(...params) {
        try {
          const cleanParams = params.map(p => p === undefined ? null : p);
          const stmt = self._db.prepare(sql);
          stmt.bind(cleanParams);
          if (stmt.step()) {
            const row = stmt.getAsObject();
            stmt.free();
            return row;
          }
          stmt.free();
          return null;
        } catch (err) {
          console.error('SQL Error:', err.message, sql, params);
          throw err;
        }
      },
      all(...params) {
        try {
          const cleanParams = params.map(p => p === undefined ? null : p);
          const results = [];
          const stmt = self._db.prepare(sql);
          stmt.bind(cleanParams);
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          stmt.free();
          return results;
        } catch (err) {
          console.error('SQL Error:', err.message, sql, params);
          throw err;
        }
      }
    };
  }

  exec(sql) {
    this._db.run(sql);
    saveDatabase();
  }
}

export async function logAction(action, entityType = null, entityId = null, details = null) {
  const db = await getDb();
  db.prepare(`
    INSERT INTO action_logs (action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?)
  `).run(action, entityType, entityId, details ? JSON.stringify(details) : null);
}

let dbWrapper = null;

export async function getDb() {
  if (!dbWrapper) {
    await initDatabase();
    dbWrapper = new Database(db);
  }
  return dbWrapper;
}

export function getDbPath() {
  return DB_PATH;
}

export default { getDb, logAction, getDbPath };
