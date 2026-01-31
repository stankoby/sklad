import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { getDb, logAction } from '../database.js';
import { getMoySkladService } from '../services/moysklad.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Получение списка задач
router.get('/tasks', async (req, res) => {
  try {
    const db = await getDb();
    const tasks = db.prepare(`
      SELECT t.*, 
        (SELECT COUNT(*) FROM packing_task_items WHERE task_id = t.id) as items_count,
        (SELECT SUM(planned_qty) FROM packing_task_items WHERE task_id = t.id) as total_items,
        (SELECT SUM(scanned_qty) FROM packing_task_items WHERE task_id = t.id) as scanned_items
      FROM packing_tasks t
      ORDER BY t.created_at DESC
    `).all();

    res.json(tasks);
  } catch (e) { console.error(e); } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение задачи с деталями
router.get('/tasks/:id', async (req, res) => {
  try {
    const db = await getDb();
    const task = db.prepare('SELECT * FROM packing_tasks WHERE id = ?').get(req.params.id);
    
    if (!task) {
      return res.status(404).json({ error: 'Task not found' } catch (e) { console.error(e); });
    }

    const items = db.prepare(`
      SELECT pti.*, p.name, p.barcode, p.article, p.image_url, p.stock, p.cell_address,
             p.requires_marking, p.meta_href, p.price
      FROM packing_task_items pti
      JOIN products p ON p.id = pti.product_id
      WHERE pti.task_id = ?
      ORDER BY p.cell_address, p.name
    `).all(req.params.id);

    // По умолчанию в задаче показываем только позиции, которые реально можно собрать сейчас
    }
    const noStockItems = items.filter(i => (i.stock || 0) <= 0);
    const visibleItems = items.filter(i => (i.stock || 0) > 0);

    const totalPlanned = visibleItems.reduce((s, i) => s + i.planned_qty, 0);
    const totalScanned = visibleItems.reduce((s, i) => s + i.scanned_qty, 0);

    res.json({ 
      task: { ...task, total_items: totalPlanned, scanned_items: totalScanned, no_stock_items: noStockItems.length }, 
      items: visibleItems,
      noStockItems: noStockItems.length ? noStockItems : undefined
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Загрузка Excel файла
router.post('/tasks/upload', upload.single('file'), async (req, res) => {
  try {
    const db = await getDb();
    
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' } catch (e) { console.error(e); });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    if (data.length === 0) {
      return res.status(400).json({ error: 'Файл пустой' });
    }

    const items = [];
    const errors = [];
    const notFound = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      
      const barcode = row.Barcode || row.barcode || row['Баркод'] || row['ШтрихКод'] || row['штрихкод'] || row['Штрих-код'] || '';
      const sku = row.SKU || row.sku || row['Артикул'] || row['артикул'] || row.Article || row.article || '';
      const name = row.Name || row.name || row['Наименование'] || row['наименование'] || row['Товар'] || '';
      const quantity = Number(row.Quantity || row.quantity || row['Количество'] || row['количество'] || row.Qty || 1);

      if (!barcode && !sku && !name) continue;
      if (!quantity || quantity <= 0) continue;

      let product = null;
      if (barcode) product = db.prepare('SELECT p.* FROM products p LEFT JOIN product_barcodes pb ON pb.product_id = p.id WHERE p.barcode = ? OR pb.barcode = ? LIMIT 1').get(String(barcode).trim(), String(barcode).trim());
      if (!product && sku) product = db.prepare('SELECT * FROM products WHERE sku = ? OR article = ?').get(String(sku).trim(), String(sku).trim());
      if (!product && name) product = db.prepare('SELECT * FROM products WHERE LOWER(name) LIKE ?').get(`%${String(name).toLowerCase().trim()}%`);

      if (!product) {
        notFound.push({ row: i + 2, barcode, sku, name, quantity });
        continue;
      }

      
      const available = Number(product.stock || 0);

      // Если нет остатка или он отрицательный — не добавляем в задачу.
      if (!Number.isFinite(available) || available <= 0) {
        errors.push({ row: i + 2, barcode, sku, name, quantity, reason: 'no_stock' });
        continue;
      }

      // Если в Excel хотят больше, чем есть — режем до доступного (иначе задача заведомо невыполнима)
      const qty = Math.min(quantity, available);

      items.push({ product, quantity: qty, available });

    }

    if (items.length === 0) {
      return res.status(400).json({ error: 'Не найдено товаров', notFound });
    }

    const taskName = `Сборка ${new Date().toLocaleDateString('ru')} ${new Date().toLocaleTimeString('ru', {hour: '2-digit', minute: '2-digit'})}`;
    const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);

    const taskResult = db.prepare(`INSERT INTO packing_tasks (name, status, total_items) VALUES (?, 'active', ?)`).run(taskName, totalQty);
    const taskId = taskResult.lastInsertRowid;

    const insertItem = db.prepare(`INSERT INTO packing_task_items (task_id, product_id, planned_qty, scanned_qty, requires_marking) VALUES (?, ?, ?, 0, ?)`);
    for (const item of items) {
      insertItem.run(taskId, item.product.id, item.quantity, item.product.requires_marking ? 1 : 0);
    }


    // Авто-обновление адресов хранения (ячейки) для товаров задачи через отчёт МойСклад:
    // /report/stock/byslot/current?filter=assortmentId=...;storeId=...
    // Это точечный запрос, поэтому делаем его только для товаров текущей задачи.
    try {

const moysklad = getMoySkladService();
const uniqIds = [...new Set(items.map(i => i.product.id).filter(Boolean))];

// storeId можно указать явно (быстрее и надёжнее), либо будет вычислен из MOYSKLAD_STORE_NAME
const storeIdEnv = (process.env.MOYSKLAD_STORE_ID || '').trim() || null;
const storeId = storeIdEnv || (await moysklad.storeId());

if (!storeId) {
  throw new Error('Не удалось определить storeId. Укажите MOYSKLAD_STORE_ID или MOYSKLAD_STORE_NAME');
} catch (e) { console.error(e); }// 1) Справочник слотов склада: slotId -> slotName
const slotNameById = await moysklad.getStoreSlotNameMap(storeId);

// 2) Остатки по слотам для товаров задачи: assortmentId + slotId + stock
const rows = await moysklad.getSlotsCurrentForAssortments(uniqIds, storeId);

const bestById = new Map(); // productId -> { addr, qty }

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

for (const r of rows) {
  const pid = r?.assortmentId ? String(r.assortmentId) : null;
  const sid = r?.slotId ? String(r.slotId) : null;
  if (!pid || !sid) continue;

  const addr = (slotNameById.get(sid) || '').trim() || null;
  if (!addr) continue;

  const qty = num(r.stock);

  const prev = bestById.get(pid);
  if (!prev || qty > prev.qty) {
    bestById.set(pid, { addr, qty });
  }
}

if (bestById.size > 0) {
  const upd = db.prepare('UPDATE products SET cell_address = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  for (const [pid, v] of bestById.entries()) {
    upd.run(v.addr, pid);
  }
  console.log(`[slots] updated cell_address for ${bestById.size} products`);
} else {
  console.warn('[slots] no locations resolved (bestById empty).');
}
    } catch (e) {
      // Не считаем это фатальной ошибкой для создания задачи: если отчёт недоступен,
      // маршрутный лист всё равно будет работать по стеллажам/без ячеек.
      console.warn('Slot locations refresh skipped:', e?.message || e);
    }

    const skippedNoStock = errors.filter(e => e.reason === 'no_stock');
    res.json({ success: true, taskId, created: items.length, totalQuantity: totalQty, notFound: notFound.length > 0 ? notFound : undefined, skippedNoStock: skippedNoStock.length > 0 ? skippedNoStock : undefined });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Ошибка загрузки', message: error.message });
  }
});

// Создание задачи вручную
router.post('/tasks', async (req, res) => {
  try {
    const db = await getDb();
    const { name, items } catch (e) { console.error(e); }= req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Не указаны товары' });
    }

    const taskName = name || `Сборка ${new Date().toLocaleDateString('ru')} ${new Date().toLocaleTimeString('ru', {hour: '2-digit', minute: '2-digit'})}`;
    
    let totalQty = 0;
    const validItems = [];

    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
      if (product) {
        validItems.push({ product, quantity: item.quantity || 1 });
        totalQty += item.quantity || 1;
      }
    }

    if (validItems.length === 0) {
      return res.status(400).json({ error: 'Не найдено товаров' });
    }

    const taskResult = db.prepare(`INSERT INTO packing_tasks (name, status, total_items) VALUES (?, 'active', ?)`).run(taskName, totalQty);
    const taskId = taskResult.lastInsertRowid;

    const insertItem = db.prepare(`INSERT INTO packing_task_items (task_id, product_id, planned_qty, scanned_qty, requires_marking) VALUES (?, ?, ?, 0, ?)`);
    for (const item of validItems) {
      insertItem.run(taskId, item.product.id, item.quantity, item.product.requires_marking ? 1 : 0);
    }

    res.json({ success: true, taskId, itemsCount: validItems.length, totalQuantity: totalQty });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Добавление товара в задачу
router.post('/tasks/:id/items', async (req, res) => {
  try {
    const db = await getDb();
    const taskId = req.params.id;
    const { productId, quantity = 1 } catch (e) { console.error(e); }= req.body;

    const task = db.prepare('SELECT * FROM packing_tasks WHERE id = ?').get(taskId);
    if (!task || task.status !== 'active') {
      return res.status(400).json({ error: 'Задача не активна' });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    const existing = db.prepare('SELECT * FROM packing_task_items WHERE task_id = ? AND product_id = ?').get(taskId, productId);
    
    if (existing) {
      db.prepare('UPDATE packing_task_items SET planned_qty = planned_qty + ? WHERE id = ?').run(quantity, existing.id);
    } else {
      db.prepare(`INSERT INTO packing_task_items (task_id, product_id, planned_qty, scanned_qty, requires_marking) VALUES (?, ?, ?, 0, ?)`).run(taskId, productId, quantity, product.requires_marking ? 1 : 0);
    }

    db.prepare(`UPDATE packing_tasks SET total_items = (SELECT SUM(planned_qty) FROM packing_task_items WHERE task_id = ?) WHERE id = ?`).run(taskId, taskId);

    res.json({ success: true, product: product.name, quantity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Сканирование товара (поддерживает коробки + Честный знак)
router.post('/tasks/:id/scan', async (req, res) => {
  try {
    const db = await getDb();
    const taskId = req.params.id;
    const barcode = String(req.body.barcode || '').trim();
    const boxId = req.body.boxId ?? req.body.box_id ?? null;
    const chestnyZnak = (req.body.chestnyZnak ?? req.body.chestny_znak ?? req.body.markingCode ?? '').toString().trim();

    if (!barcode) {
      return res.status(400).json({ error: 'Не указан штрихкод' } catch (e) { console.error(e); });
    }

    const task = db.prepare('SELECT * FROM packing_tasks WHERE id = ?').get(taskId);
    if (!task || task.status !== 'active') {
      return res.status(400).json({ error: 'Задача не активна' });
    }

    const product = db.prepare('SELECT p.* FROM products p LEFT JOIN product_barcodes pb ON pb.product_id = p.id WHERE p.barcode = ? OR pb.barcode = ? LIMIT 1').get(barcode, barcode);
    if (!product) {
      return res.status(404).json({ error: 'Товар не найден', barcode });
    }

    const taskItem = db.prepare(`SELECT * FROM packing_task_items WHERE task_id = ? AND product_id = ?`).get(taskId, product.id);
    if (!taskItem) {
      return res.status(400).json({ error: 'Товар не в задаче', product: product.name });
    }

    if (taskItem.scanned_qty >= taskItem.planned_qty) {
      return res.status(400).json({ error: 'Товар уже собран', product: product.name });
    }

    // Если указан короб — записываем в короб. Иначе оставляем старую логику (просто увеличить scanned_qty)
    if (boxId) {
      const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(boxId);
      if (!box || String(box.task_id) !== String(taskId)) {
        return res.status(400).json({ error: 'Короб не найден или не относится к задаче' });
      }
      if (box.status !== 'open') {
        return res.status(400).json({ error: 'Короб закрыт' });
      }

      // Честный знак: требуем код маркировки для каждого скана
      if (Number(taskItem.requires_marking) === 1) {
        if (!chestnyZnak) {
          return res.status(400).json({ error: 'Нужен код маркировки (Честный знак)', requiresMarking: true, product: product.name });
        }
      }

      // Запись факта упаковки в короб
      db.prepare(`INSERT INTO box_items (box_id, product_id, quantity, chestny_znak) VALUES (?, ?, 1, ?)`)
        .run(boxId, product.id, chestnyZnak || null);

      // Увеличиваем счетчик собранного
      db.prepare(`UPDATE packing_task_items SET scanned_qty = scanned_qty + 1 WHERE id = ?`).run(taskItem.id);

    } else {
      // Старый режим: просто увеличиваем scanned_qty
      db.prepare(`UPDATE packing_task_items SET scanned_qty = scanned_qty + 1 WHERE id = ?`).run(taskItem.id);
    }

    const updated = db.prepare(`SELECT * FROM packing_task_items WHERE id = ?`).get(taskItem.id);

    res.json({
      success: true,
      product: product.name,
      productId: product.id,
      scanned: updated.scanned_qty,
      quantity: updated.planned_qty,
      complete: updated.scanned_qty >= updated.planned_qty,
      boxId: boxId || undefined,
      requiresMarking: Number(updated.requires_marking) === 1
    });
  } catch (err) {
    // Ошибка UNIQUE по ЧЗ — показываем понятнее
    if (String(err.message || '').toLowerCase().includes('unique')) {
      return res.status(400).json({ error: 'Этот код маркировки уже использован' });
    }
    res.status(500).json({ error: err.message });
  }
});



// Список коробов по задаче
router.get('/tasks/:id/boxes', async (req, res) => {
  try {
    const db = await getDb();
    const taskId = req.params.id;

    const task = db.prepare('SELECT * FROM packing_tasks WHERE id = ?').get(taskId);
    if (!task) return res.status(404).json({ error: 'Задача не найдена' } catch (e) { console.error(e); });

    const boxes = db.prepare(`
      SELECT b.*, 
        (SELECT COALESCE(SUM(quantity),0) FROM box_items bi WHERE bi.box_id = b.id) AS items_qty,
        (SELECT COUNT(*) FROM box_items bi WHERE bi.box_id = b.id) AS scans_count
      FROM boxes b
      WHERE b.task_id = ?
      ORDER BY b.number ASC
    `).all(taskId);

    // Содержимое (для печати/просмотра)
    const items = db.prepare(`
      SELECT b.id as box_id, b.number as box_number, p.name, p.barcode, bi.product_id,
             COALESCE(SUM(bi.quantity),0) as qty,
             MAX(p.requires_marking) as requires_marking
      FROM boxes b
      JOIN box_items bi ON bi.box_id = b.id
      JOIN products p ON p.id = bi.product_id
      WHERE b.task_id = ?
      GROUP BY b.id, bi.product_id
      ORDER BY b.number ASC, p.name ASC
    `).all(taskId);

    res.json({ boxes, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Создать новый короб
router.post('/tasks/:id/boxes', async (req, res) => {
  try {
    const db = await getDb();
    const taskId = req.params.id;

    const task = db.prepare('SELECT * FROM packing_tasks WHERE id = ?').get(taskId);
    if (!task || task.status !== 'active') {
      return res.status(400).json({ error: 'Задача не активна' } catch (e) { console.error(e); });
    }

    const last = db.prepare('SELECT MAX(number) as maxNum FROM boxes WHERE task_id = ?').get(taskId);
    const nextNum = (last?.maxNum || 0) + 1;

    const r = db.prepare(`INSERT INTO boxes (task_id, number, status) VALUES (?, ?, 'open')`).run(taskId, nextNum);
    res.json({ success: true, box: { id: r.lastInsertRowid, task_id: Number(taskId), number: nextNum, status: 'open' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Закрыть короб
router.post('/tasks/:id/boxes/:boxId/close', async (req, res) => {
  try {
    const db = await getDb();
    const { id: taskId, boxId } catch (e) { console.error(e); }= req.params;

    const task = db.prepare('SELECT * FROM packing_tasks WHERE id = ?').get(taskId);
    if (!task || task.status !== 'active') {
      return res.status(400).json({ error: 'Задача не активна' });
    }

    const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(boxId);
    if (!box || String(box.task_id) !== String(taskId)) {
      return res.status(400).json({ error: 'Короб не найден' });
    }

    // Проверка: если в коробе есть товары с ЧЗ, у каждого скана должен быть код маркировки
    const missingMarks = db.prepare(`
      SELECT p.name, COUNT(*) as cnt
      FROM box_items bi
      JOIN products p ON p.id = bi.product_id
      WHERE bi.box_id = ? AND p.requires_marking = 1 AND (bi.chestny_znak IS NULL OR TRIM(bi.chestny_znak) = '')
      GROUP BY p.id
    `).all(boxId);

    if (missingMarks && missingMarks.length > 0) {
      return res.status(400).json({
        error: 'В коробе есть маркируемые товары без кода (Честный знак)',
        missing: missingMarks
      });
    }

    db.prepare(`UPDATE boxes SET status = 'closed' WHERE id = ?`).run(boxId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Маршрутный лист
router.get('/tasks/:id/route-sheet', async (req, res) => {
  try {
    const db = await getDb();
    const taskId = req.params.id;

    const task = db.prepare('SELECT * FROM packing_tasks WHERE id = ?').get(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const items = db.prepare(`
      SELECT pti.id, pti.product_id, pti.planned_qty, pti.scanned_qty,
             p.name, p.article, p.barcode, p.stock
      FROM packing_task_items pti
      JOIN products p ON p.id = pti.product_id
      WHERE pti.task_id = ?
    `).all(taskId);

    const moysklad = getMoySkladService();
    const storeId = (process.env.MOYSKLAD_STORE_ID || '').trim() || (await moysklad.storeId());

    if (!storeId) {
      return res.status(500).json({ error: 'Не удалось определить storeId' });
    }

    const productIds = [...new Set(items.map((it) => it.product_id).filter(Boolean))];
    const slotNameById = await moysklad.getStoreSlotNameMap(storeId);
    const slotRows = await moysklad.getSlotsCurrentForAssortments(productIds, storeId);

    const extractIdFromHref = (href) => {
      if (!href) return null;
      const match = String(href).match(/\/([0-9a-f\-]{20,})$/i);
      return match ? match[1] : null;
    };

    const resolveId = (candidate, fallbackHref) => {
      if (candidate) return String(candidate);
      return extractIdFromHref(fallbackHref);
    };

    const bestSlotByProduct = new Map();
    for (const row of slotRows) {
      const productId = resolveId(row?.assortmentId, row?.assortment?.meta?.href);
      const slotId = resolveId(row?.slotId, row?.slot?.meta?.href);
      if (!productId || !slotId) continue;

      const slotName = slotNameById.get(slotId);
      if (!slotName) continue;

      const stock = Number(row?.stock ?? 0) || 0;
      const prev = bestSlotByProduct.get(productId);
      if (!prev || stock > prev.stock) {
        bestSlotByProduct.set(productId, { slotName, stock });
      }
    }

    const parseCellAddress = (addr) => {
      if (!addr) return { rack: null, shelf: null, cell: null };
      const s = String(addr).trim();

      // МоёСклад отдаёт имена ячеек/слотов в разном формате.
      // Встречается: "Стелаж.1, полка 1, ячейка A", "Стеллаж 50  полка 1 ячейка С", и т.п.
      // Делаем разбор максимально терпимым: стелаж/стеллаж, точки/запятые, лишние пробелы.

      const rack = (() => {
        const m = s.match(/стел+аж\.?\s*(\d+)/i);
        return m ? Number(m[1]) : null;
      })();

      const shelf = (() => {
        const m = s.match(/полка\s*(\d+)/i);
        return m ? Number(m[1]) : null;
      })();

      const cell = (() => {
        const m = s.match(/ячейк\S*\s*([A-Za-zА-Яа-я0-9]+)/i);
        return m ? String(m[1]).toUpperCase() : null;
      })();

      return { rack, shelf, cell };
    };

    const enriched = items.map((item) => {
      const slotInfo = bestSlotByProduct.get(String(item.product_id));
      const cell_address = slotInfo?.slotName || null;
      const qty_to_collect = Math.max((item.planned_qty ?? 0) - (item.scanned_qty ?? 0), 0);
      const loc = parseCellAddress(cell_address);
      return {
        ...item,
        cell_address,
        qty_to_collect,
        ...loc,
      };
    });

    const noStock = enriched.filter((i) => (i.stock ?? 0) <= 0 && i.qty_to_collect > 0);
    const hangingStock = enriched.filter((i) => !i.cell_address && i.qty_to_collect > 0);

    const available = enriched.filter(
      (i) => i.cell_address && (i.stock ?? 0) > 0 && i.qty_to_collect > 0,
    );

    const rackOrderList = [
      41, 42, 37, 38, 39, 40, 52, 51, 50, 49, 32, 36, 31, 35, 30, 34, 29, 33, 28, 23, 18,
      19, 24, 20, 25, 21, 26, 22, 27, 48, 47, 46, 12, 17, 11, 16, 10, 15, 9, 14, 8, 13, 1,
      2, 3, 4, 5, 6, 7, 45, 44, 43,
    ];
    const rackOrderMap = new Map(rackOrderList.map((rack, index) => [rack, index]));

    available.sort((a, b) => {
      const ar = rackOrderMap.get(a.rack) ?? 9999;
      const br = rackOrderMap.get(b.rack) ?? 9999;
      if (ar !== br) return ar - br;

      const ashelf = a.shelf ?? 9999;
      const bshelf = b.shelf ?? 9999;
      if (ashelf !== bshelf) return ashelf - bshelf;

      const acell = a.cell ?? '';
      const bcell = b.cell ?? '';
      return acell.localeCompare(bcell);
    });

    const zonesMap = new Map();
    for (const it of available) {
      const key = it.rack ?? 'Без ячейки';
      if (!zonesMap.has(key)) zonesMap.set(key, []);
      zonesMap.get(key).push({
        id: it.id,
        product_id: it.product_id,
        name: it.name,
        barcode: it.barcode,
        cell_address: it.cell_address,
        qty_to_collect: it.qty_to_collect,
      });
    }

    const zones = {};
    for (const [rack, rows] of zonesMap.entries()) {
      zones[String(rack)] = rows;
    }

    res.json({
      task,
      available: available.length,
      totalToCollect: available.reduce((sum, row) => sum + (row.qty_to_collect || 0), 0),
      zones,
      noStock: noStock.map((row) => ({
        id: row.id,
        product_id: row.product_id,
        name: row.name,
        planned_qty: row.planned_qty,
      })),
      noStockCount: noStock.length,
      hangingStock: hangingStock.map((row) => ({
        id: row.id,
        product_id: row.product_id,
        name: row.name,
        planned_qty: row.planned_qty,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
