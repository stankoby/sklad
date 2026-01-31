import { Router } from 'express';
import { getDb, logAction } from '../database.js';
import { getMoySkladService } from '../services/moysklad.js';
import multer from 'multer';
import xlsx from 'xlsx';

const router = Router();

// Нормализует имя ячейки/слота из МойСклад в стабильный формат,
// чтобы группировка маршрутного листа находила стеллаж/полку/ячейку.
// Поддерживает варианты: "Стелаж.1, полка 1, ячейка A", "Стеллаж 50  полка 1 ячейка С" и т.п.
function normalizeSlotName(raw) {
  const name = (raw || '').toString().trim();
  if (!name) return null;

  const lower = name.toLowerCase();
  // стеллаж/стелаж с точкой и запятыми
  const rackMatch = lower.match(/стел(?:лаж|аж)\.?\s*(\d+)/i);
  const shelfMatch = lower.match(/полк[аиы]?\s*(\d+)/i);
  const cellMatch = name.match(/ячейк[аиы]?\s*([A-Za-zА-Яа-я0-9]+)/i);

  const rack = rackMatch?.[1] ? Number(rackMatch[1]) : null;
  const shelf = shelfMatch?.[1] ? Number(shelfMatch[1]) : null;
  const cell = cellMatch?.[1] ? String(cellMatch[1]).trim() : null;

  if (rack && shelf && cell) {
    return `Стеллаж ${rack} полка ${shelf} ячейка ${cell}`;
  }

  // если не получилось распарсить все части — вернём исходное, но чуть почистим
  return name.replace(/\s+/g, ' ');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// Получение списка товаров
router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const { search, noBarcode, limit = 100, offset = 0 } = req.query;
    
    let sql = 'SELECT * FROM products WHERE 1=1';
    const params = [];

    if (search) {
      // Регистронезависимый поиск для кириллицы через LOWER
      const searchLower = search.toLowerCase();
      sql += ' AND (LOWER(name) LIKE ? OR LOWER(barcode) LIKE ? OR LOWER(sku) LIKE ? OR LOWER(article) LIKE ?)';
      const term = `%${searchLower}%`;
      params.push(term, term, term, term);
    }

    if (noBarcode === 'true') {
      sql += ' AND (barcode IS NULL OR barcode = "")';
    }

    sql += ' ORDER BY name LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));

    const products = db.prepare(sql).all(...params);
    
    const result = products.map(p => ({
      ...p,
      hasImage: !!p.image_url
    }));

    const countSql = 'SELECT COUNT(*) as total FROM products';
    const totalRow = db.prepare(countSql).get();

    res.json({ products: result, total: totalRow?.total || 0 });
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: err.message });
  }
});

// Получение изображения товара
router.get('/:id/image', async (req, res) => {
  try {
    const moysklad = getMoySkladService();
    const image = await moysklad.getProductImageDownload(req.params.id);

    if (!image) {
      return res.status(404).json({ error: 'Image not found' });
    }

    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(image.data));
  } catch (err) {
    console.error('Error fetching product image:', err);
    res.status(500).json({ error: err.message });
  }
});

// Получение товара по ID
router.get('/:id', async (req, res) => {
  try {
    const db = await getDb();
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Поиск по штрихкоду
router.get('/barcode/:barcode', async (req, res) => {
  try {
    const db = await getDb();
    const product = db.prepare('SELECT * FROM products WHERE barcode = ?').get(req.params.barcode);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Поиск по артикулу
router.get('/article/:article', async (req, res) => {
  try {
    const db = await getDb();
    const product = db.prepare('SELECT * FROM products WHERE article = ? OR sku = ?').get(req.params.article, req.params.article);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Синхронизация с МойСклад
router.post('/sync', async (req, res) => {
  try {
    const db = await getDb();
    const moysklad = getMoySkladService();
    
    db.prepare('UPDATE sync_status SET status = ? WHERE id = 1').run('syncing');
    await logAction('sync_started');

    // Получаем товары
    const products = await moysklad.getAllProducts();
    
    // Получаем остатки
    const stockData = await moysklad.getStock();

    // --- Индексы остатков ---
    // stockData приходит из /report/stock/all (или нормализованный фолбэк) и может иметь разные формы.
    // Нужны быстрые мапы:
    //  - stockMap: по UUID ассортимента -> остаток
    //  - stockByBarcode: по штрихкоду -> остаток (если штрихкоды присутствуют в отчёте)
    //  - stockByArticle: по артикулу/коду -> остаток
    const stockMap = new Map();
    const stockByBarcode = new Map();
    const stockByArticle = new Map();

    const extractIdFromHref = (href) => {
      if (!href) return null;
      const s = String(href);
      // .../entity/product/<uuid>
      const m = s.match(/\/entity\/(?:product|variant|bundle|service|consignment|productFolder|productfolder)\/([0-9a-f\-]{20,})/i);
      return m ? m[1] : null;
    };

    const putMax = (map, key, val) => {
      if (!key) return;
      const k = String(key).trim();
      if (!k) return;
      const n = Number(val || 0) || 0;
      const cur = Number(map.get(k) || 0) || 0;
      if (n > cur) map.set(k, n);
    };

    for (const r of Array.isArray(stockData) ? stockData : []) {
      const href = r?.meta?.href || r?.assortment?.meta?.href || r?.assortment?.href || r?.meta?.uuidHref;
      const id = extractIdFromHref(href);
      const stock = Number(r?.stock ?? r?.quantity ?? r?.available ?? 0) || 0;
      if (id) putMax(stockMap, id, stock);

      // Артикул/код
      putMax(stockByArticle, r?.article, stock);
      putMax(stockByArticle, r?.code, stock);
      putMax(stockByArticle, r?.sku, stock);

      // Штрихкоды (если отчёт их вернул)
      const bcs = [];
      if (r?.barcode) bcs.push(r.barcode);
      if (Array.isArray(r?.barcodes)) bcs.push(...r.barcodes);
      if (Array.isArray(r?.assortment?.barcodes)) bcs.push(...r.assortment.barcodes);
      for (const bc of bcs) putMax(stockByBarcode, bc, stock);
    }

    // --- Адреса ячеек (slot) ---
    // МойСклад: /report/stock/byslot/current даёт только slotId, а читать слот можно ТОЛЬКО через
    // /entity/store/{storeId}/slots/{slotId} (или собрать мапу через /entity/store/{storeId}/slots).
    // Здесь делаем "best-effort" обновление адресов:
    // 1) берём мапу slotId -> slot.name
    // 2) берём отчёт byslot/current пачками по ассортиментам
    // 3) выбираем слот с максимальным stock как основной адрес товара
    // Если что-то падает — не ломаем sync, просто оставляем старые cell_address.
    const cellById = new Map();
    const existingCellById = new Map();
    try {
      const rows = db.prepare('SELECT id, cell_address FROM products').all();
      for (const r of rows) {
        if (r?.id) existingCellById.set(String(r.id), r.cell_address || null);
      }
    } catch (e) {
      // ignore
    }

    try {
      const storeId = await moysklad.storeId();
      if (storeId) {
        const slots = await moysklad.getAllStoreSlots(storeId);
        const slotNameById = new Map();
        for (const s of slots) {
          if (s?.id) slotNameById.set(String(s.id), s.name || null);
        }

        const ids = products.map((p) => String(p.id)).filter(Boolean);
        const chunkSize = 200;
        const bestSlotByAssortment = new Map();

        for (let i = 0; i < ids.length; i += chunkSize) {
          const chunk = ids.slice(i, i + chunkSize);
          const rows = await moysklad.getSlotsCurrentForAssortments(chunk, storeId);
          for (const r of Array.isArray(rows) ? rows : []) {
            const aid = String(r.assortmentId || '').trim();
            const slotId = String(r.slotId || '').trim();
            const qty = Number(r.stock || 0) || 0;
            if (!aid || !slotId) continue;
            const cur = bestSlotByAssortment.get(aid);
            if (!cur || qty > cur.qty) bestSlotByAssortment.set(aid, { slotId, qty });
          }
        }

        for (const [aid, { slotId }] of bestSlotByAssortment.entries()) {
          const rawName = slotNameById.get(slotId) || null;
          const normalized = normalizeSlotName(rawName);
          if (normalized) cellById.set(aid, { cell: normalized, raw: rawName, slotId });
          else if (rawName) cellById.set(aid, { cell: rawName, raw: rawName, slotId });
        }
      }
    } catch (e) {
      console.warn('[sync] slots update skipped:', e?.message || e);
    }


    // Upsert для товаров.
    // Важно: в sql.js именованные плейсхолдеры (@id) легко ломаются, если передавать позиционные параметры.
    // Поэтому здесь используем только позиционные "?".
    // Также держим схему в точности как в database.js (11 колонок) — иначе будет column index out of range.
    const insertStmt = db.prepare(
      `INSERT INTO products (
         id, name, article, barcode, sku, price, stock, image_url, meta_href, requires_marking, cell_address
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         article = excluded.article,
         barcode = excluded.barcode,
         sku = excluded.sku,
         price = excluded.price,
         stock = excluded.stock,
         image_url = excluded.image_url,
         meta_href = excluded.meta_href,
         requires_marking = excluded.requires_marking,
         cell_address = excluded.cell_address,
         updated_at = CURRENT_TIMESTAMP`
    );

    for (const product of products) {
      const id = product.id;

      const extractBarcodes = (p) => {
        const out = [];
        const push = (v) => {
          if (!v) return;
          const s = String(v).trim();
          if (!s) return;
          if (!out.includes(s)) out.push(s);
        };

        // Основные штрихкоды (иногда массив объектов, иногда строк)
        const bcs = p?.barcodes;
        if (Array.isArray(bcs)) {
          for (const b of bcs) {
            if (typeof b === 'string') push(b);
            else {
              push(b?.ean13);
              push(b?.ean8);
              push(b?.code128);
            }
          }
        }

        // Штрихкоды упаковок (packs) — часто именно они в Excel
        const packs = p?.packs || p?.pack || null;
        if (Array.isArray(packs)) {
          for (const pack of packs) {
            const pb = pack?.barcodes;
            if (Array.isArray(pb)) {
              for (const b of pb) {
                if (typeof b === 'string') push(b);
                else {
                  push(b?.ean13);
                  push(b?.ean8);
                  push(b?.code128);
                }
              }
            }
          }
        } else if (packs && typeof packs === 'object') {
          const pb = packs?.barcodes;
          if (Array.isArray(pb)) {
            for (const b of pb) {
              if (typeof b === 'string') push(b);
              else {
                push(b?.ean13);
                push(b?.ean8);
                push(b?.code128);
              }
            }
          }
        }

        return out;
      };

      const allBarcodes = extractBarcodes(product);
      const primaryBarcode = allBarcodes[0] || '';

      // Получаем URL миниатюры изображения (для variants обычно нет)
      let imageUrl = null;
      if (product.images?.meta?.size > 0 && product.images?.rows?.length > 0) {
        const img = product.images.rows[0];
        imageUrl = img.miniature?.href || img.tiny?.href || null;
      }

      // Для variant часть полей может быть в product.product
      const base = product.product || {};
      const name = product.name || base.name || '';
      const article = product.article || base.article || '';
      const sku = product.code || base.code || '';

      // Проверяем требуется ли маркировка
      const requiresMarking = product.trackingType && product.trackingType !== 'NOT_TRACKED' ? 1 : 0;

      // Адрес ячейки (из отчёта остатков по ячейкам). Берём наиболее "значимую" ячейку (с максимальным qty).
      const cellAddress = (cellById.get(id)?.cell) ?? (existingCellById.get(id) ?? null);

      // Остаток: пытаемся матчить по id ассортимента (надежно), затем по любому штрихкоду (товар/упаковки),
      // затем по артикулу/коду. Это критично, т.к. в Excel часто лежит штрихкод упаковки, а в отчёте — базовый.
      let stock = stockMap.get(id) ?? 0;

      if (!stock) {
        for (const bc of allBarcodes) {
          const s = stockByBarcode.get(bc);
          if (s) { stock = s; break; }
        }
      }

      if (!stock) {
        const a = String(article || '').trim();
        const c = String(sku || '').trim();
        stock = (a ? (stockByArticle.get(a) ?? 0) : 0) || (c ? (stockByArticle.get(c) ?? 0) : 0);
      }

      insertStmt.run(
        id,
        name,
        article,
        primaryBarcode,
        sku,
        (product.salePrices?.[0]?.value || base.salePrices?.[0]?.value || 0) / 100,
        stock,
        imageUrl || null,
        product.meta?.href || base.meta?.href || '',
        requiresMarking,
        cellAddress
      );

      // Обновляем таблицу дополнительных штрихкодов
      try {
        deleteBarcodesStmt.run(id);
        for (const bc of allBarcodes) {
          insertBarcodeStmt.run(id, bc);
        }
      } catch (e) {
        // не критично для синхронизации
      }
    }

    // Синхронизируем заказы поставщикам
    const orders = await moysklad.getPurchaseOrders();
    
    const insertOrder = db.prepare(`
      INSERT OR REPLACE INTO purchase_orders 
      (id, name, moment, supplier_name, total_items, meta_href, agent_meta, organization_meta, store_meta, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const deleteOrderItems = db.prepare('DELETE FROM purchase_order_items WHERE order_id = ?');
    const insertOrderItem = db.prepare(`
      INSERT INTO purchase_order_items (order_id, product_id, ordered_qty)
      VALUES (?, ?, ?)
    `);

    for (const order of orders) {
      const totalItems = order.positions?.meta?.size || 0;
      
      // Сохраняем meta как JSON строки для точного восстановления
      const agentMeta = order.agent?.meta ? JSON.stringify(order.agent.meta) : null;
      const organizationMeta = order.organization?.meta ? JSON.stringify(order.organization.meta) : null;
      const storeMeta = order.store?.meta ? JSON.stringify(order.store.meta) : null;
      
      insertOrder.run(
        order.id,
        order.name || '',
        order.moment || '',
        order.agent?.name || '',
        totalItems,
        order.meta?.href || '',
        agentMeta,
        organizationMeta,
        storeMeta
      );

      // Получаем позиции заказа
      if (totalItems > 0) {
        deleteOrderItems.run(order.id);
        const positions = await moysklad.getPurchaseOrderPositions(order.id);
        
        for (const pos of positions) {
          const productId = pos.assortment?.meta?.href?.split('/').pop();
          if (productId) {
            insertOrderItem.run(order.id, productId, pos.quantity || 0);
          }
        }
      }
    }

    // Обновляем статус
    db.prepare(`
      UPDATE sync_status 
      SET last_sync = datetime('now'), products_count = ?, orders_count = ?, status = 'success'
      WHERE id = 1
    `).run(products.length, orders.length);

    await logAction('sync_completed', 'products', null, { products: products.length, orders: orders.length });

    res.json({ 
      success: true, 
      productsCount: products.length,
      ordersCount: orders.length,
      message: `Синхронизировано: ${products.length} товаров, ${orders.length} заказов`
    });

  } catch (error) {
    const db = await getDb();
    db.prepare('UPDATE sync_status SET status = ? WHERE id = 1').run('error');
    await logAction('sync_failed', null, null, { error: error.message });
    console.error('Sync error:', error);
    res.status(500).json({ error: 'Sync failed', message: error.message });
  }
});

// Статус синхронизации
router.get('/sync/status', async (req, res) => {
  try {
    const db = await getDb();
    const status = db.prepare('SELECT * FROM sync_status WHERE id = 1').get();
    
    let connected = false;
    let connectionError = null;

    try {
      const moysklad = getMoySkladService();
      const check = await moysklad.checkConnection();
      connected = check.connected;
      connectionError = check.error;
    } catch (error) {
      connectionError = error.message;
    }

    res.json({ ...status, connected, connectionError });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Загрузка XLS отчёта "Остатки по ячейкам" из интерфейса МойСклад.
// Это единственный стабильный способ получить адреса ячеек (стеллаж/полка/ячейка) по API.
router.post('/locations/upload', upload.single('file'), async (req, res) => {
  try {
    const db = await getDb();
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames?.[0];
    if (!sheetName) return res.status(400).json({ error: 'Не найден лист в файле' });
    const ws = wb.Sheets[sheetName];

    // Читаем как массив строк (header:1), чтобы самим найти строку заголовков.
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

    const norm = (v) => String(v ?? '').trim();
    const lower = (v) => norm(v).toLowerCase();

    // Ищем строку с заголовками: "Код", "Артикул", "Ячейка", "Доступно"
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 50); i++) {
      const r = rows[i] || [];
      const joined = r.map(lower).join(' | ');
      if (joined.includes('код') && joined.includes('ячейка') && joined.includes('доступ')) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) {
      return res.status(400).json({ error: 'Не удалось найти строку заголовков. Ожидаем отчёт "Остатки по ячейкам".' });
    }

    const header = (rows[headerIdx] || []).map(lower);
    const idx = {
      code: header.findIndex((h) => h === 'код' || h.includes('код')),
      article: header.findIndex((h) => h === 'артикул' || h.includes('артикул')),
      cell: header.findIndex((h) => h === 'ячейка' || h.includes('ячейка')),
      available: header.findIndex((h) => h.includes('доступ')),
      name: header.findIndex((h) => h.includes('наименование')),
    };
    if (idx.code === -1 && idx.article === -1) {
      return res.status(400).json({ error: 'В отчёте нет колонок "Код"/"Артикул" — нечем сопоставлять товары' });
    }
    if (idx.cell === -1) {
      return res.status(400).json({ error: 'В отчёте нет колонки "Ячейка"' });
    }

    const parseNum = (v) => {
      const s = norm(v).replace(',', '.');
      const n = Number(s);
      return Number.isFinite(n) ? n : 0;
    };

    // Собираем лучшую ячейку (max доступно) на ключ (sku/code) и/или article.
    const bestBySku = new Map();
    const bestByArticle = new Map();

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const code = idx.code >= 0 ? norm(r[idx.code]) : '';
      const article = idx.article >= 0 ? norm(r[idx.article]) : '';
      const cell = norm(r[idx.cell]);
      const available = idx.available >= 0 ? parseNum(r[idx.available]) : 0;

      // иногда в отчёте есть пустые строки-разделители
      if (!cell || cell.toLowerCase() === 'ячейка') continue;
      if (!code && !article) continue;

      const rec = { cell, available };
      if (code) {
        const prev = bestBySku.get(code);
        if (!prev || (available > prev.available)) bestBySku.set(code, rec);
      }
      if (article) {
        const prev = bestByArticle.get(article);
        if (!prev || (available > prev.available)) bestByArticle.set(article, rec);
      }
    }

    // Обновляем products.cell_address:
    // 1) по sku (в МойСклад это code)
    // 2) по article
    const upd = db.prepare('UPDATE products SET cell_address = ?, updated_at = datetime(\'now\') WHERE id = ?');
    const selectBySku = db.prepare('SELECT id FROM products WHERE sku = ?');
    const selectByArticle = db.prepare('SELECT id FROM products WHERE article = ?');

    let updated = 0;
    const touched = new Set();

    for (const [sku, rec] of bestBySku.entries()) {
      const row = selectBySku.get(sku);
      if (row?.id) {
        upd.run(rec.cell, row.id);
        updated++;
        touched.add(String(row.id));
      }
    }
    for (const [article, rec] of bestByArticle.entries()) {
      const row = selectByArticle.get(article);
      if (row?.id && !touched.has(String(row.id))) {
        upd.run(rec.cell, row.id);
        updated++;
      }
    }

    await logAction('locations_uploaded', null, null, {
      file: req.file.originalname,
      rows: rows.length,
      skuMapped: bestBySku.size,
      articleMapped: bestByArticle.size,
      updated
    });

    res.json({ ok: true, updated, skuMapped: bestBySku.size, articleMapped: bestByArticle.size });
  } catch (err) {
    console.error('locations/upload error', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
