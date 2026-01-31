import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { getDb, logAction } from '../database.js';
import { getMoySkladService } from '../services/moysklad.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const rackOrderList = [
  41, 42, 37, 38, 39, 40, 52, 51, 50, 49,
  32, 36, 31, 35, 30, 34, 29, 33, 28,
  23, 18, 19, 24, 20, 25, 21, 26, 22, 27,
  48, 47, 46,
  12, 17, 11, 16, 10, 15, 9, 14, 8, 13,
  1, 2, 3, 4, 5, 6, 7, 45, 44, 43
];

const parseCellAddress = (addr) => {
  if (!addr) return { rack: null, shelf: null, cell: null };
  const s = String(addr).trim();

  const rackMatch = s.match(/стел+аж\.?\s*(\d+)/i);
  const shelfMatch = s.match(/полк(?:а|и|\.?)\s*(\d+)/i);
  const cellMatch = s.match(/яч(?:ейк\w*|\.?)\s*([A-Za-zА-Яа-я0-9]+)/i);

  const rack = rackMatch ? Number(rackMatch[1]) : null;
  const shelf = shelfMatch ? Number(shelfMatch[1]) : null;
  const cell = cellMatch ? String(cellMatch[1]).toUpperCase() : null;

  return { rack, shelf, cell };
};

const sortByRoute = (a, b) => {
  const ar = a.rack ?? null;
  const br = b.rack ?? null;

  const aIndex = ar !== null ? rackOrderList.indexOf(ar) : -1;
  const bIndex = br !== null ? rackOrderList.indexOf(br) : -1;

  if (aIndex !== bIndex) {
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  }

  const ashelf = a.shelf ?? 9999;
  const bshelf = b.shelf ?? 9999;
  if (ashelf !== bshelf) return ashelf - bshelf;

  const acell = a.cell ?? '';
  const bcell = b.cell ?? '';
  return acell.localeCompare(bcell);
};

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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение задачи с деталями
router.get('/tasks/:id', async (req, res) => {
  try {
    const db = await getDb();
    const task = db.prepare('SELECT * FROM packing_tasks WHERE id = ?').get(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const items = db.prepare(`
      SELECT pti.*, p.name, p.barcode, p.article, p.image_url, p.stock, p.cell_address,
             p.requires_marking, p.meta_href, p.price
      FROM packing_task_items pti
      JOIN products p ON p.id = pti.product_id
      WHERE pti.task_id = ?
      ORDER BY p.cell_address, p.name
    `).all(req.params.id);

    const noStockItems = items.filter((i) => (i.stock || 0) <= 0);
    const visibleItems = items.filter((i) => (i.stock || 0) > 0);

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
      return res.status(400).json({ error: 'Файл не загружен' });
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
      if (barcode) {
        product = db.prepare(`
          SELECT p.* FROM products p
          LEFT JOIN product_barcodes pb ON pb.product_id = p.id
          WHERE p.barcode = ? OR pb.barcode = ? LIMIT 1
        `).get(String(barcode).trim(), String(barcode).trim());
      }
      if (!product && sku) {
        product = db.prepare('SELECT * FROM products WHERE sku = ? OR article = ?')
          .get(String(sku).trim(), String(sku).trim());
      }
      if (!product && name) {
        product = db.prepare('SELECT * FROM products WHERE LOWER(name) LIKE ?')
          .get(`%${String(name).toLowerCase().trim()}%`);
      }

      if (!product) {
        notFound.push({ row: i + 2, barcode, sku, name, quantity });
        continue;
      }

      const available = Number(product.stock || 0);
      if (!Number.isFinite(available) || available <= 0) {
        errors.push({ row: i + 2, barcode, sku, name, quantity, reason: 'no_stock' });
        continue;
      }

      const qty = Math.min(quantity, available);
      items.push({ product, quantity: qty, available });
    }

    if (items.length === 0) {
      return res.status(400).json({ error: 'Не найдено товаров', notFound });
    }

    const taskName = `Сборка ${new Date().toLocaleDateString('ru')} ${new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}`;
    const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);

    const taskResult = db.prepare(`INSERT INTO packing_tasks (name, status, total_items) VALUES (?, 'active', ?)`)
      .run(taskName, totalQty);
    const taskId = taskResult.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO packing_task_items (task_id, product_id, planned_qty, scanned_qty, requires_marking)
      VALUES (?, ?, ?, 0, ?)
    `);
    for (const item of items) {
      insertItem.run(taskId, item.product.id, item.quantity, item.product.requires_marking ? 1 : 0);
    }

    await logAction('packing_task_created', 'packing_task', taskId, { totalQuantity: totalQty });

    const skippedNoStock = errors.filter((e) => e.reason === 'no_stock');
    res.json({
      success: true,
      taskId,
      created: items.length,
      totalQuantity: totalQty,
      notFound: notFound.length > 0 ? notFound : undefined,
      skippedNoStock: skippedNoStock.length > 0 ? skippedNoStock : undefined
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Ошибка загрузки', message: error.message });
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
             p.name, p.article, p.barcode, p.stock, p.cell_address
      FROM packing_task_items pti
      JOIN products p ON p.id = pti.product_id
      WHERE pti.task_id = ?
    `).all(taskId);

    const withLoc = items.map((it) => {
      const loc = parseCellAddress(it.cell_address);
      return { ...it, ...loc };
    });

    const available = withLoc.filter((i) => (i.stock ?? 0) > 0 && i.planned_qty > 0);
    const availableWithShelf = available.filter((i) => i.rack !== null && i.shelf !== null && i.cell !== null);
    const hangingStock = available.filter((i) => i.rack === null || i.shelf === null || i.cell === null);
    availableWithShelf.sort(sortByRoute);

    const zonesMap = new Map();
    for (const it of availableWithShelf) {
      const rack = it.rack;
      const qtyToCollect = Math.max((it.planned_qty || 0) - (it.scanned_qty || 0), 0);
      if (qtyToCollect <= 0) continue;
      if (!zonesMap.has(rack)) zonesMap.set(rack, []);
      zonesMap.get(rack).push({
        id: it.id,
        product_id: it.product_id,
        name: it.name,
        barcode: it.barcode,
        cell_address: it.cell_address,
        qty_to_collect: qtyToCollect,
        planned_qty: it.planned_qty,
        scanned_qty: it.scanned_qty,
        stock: it.stock
      });
    }

    const orderedRacks = Array.from(zonesMap.keys()).sort((a, b) => {
      const aIndex = rackOrderList.indexOf(a);
      const bIndex = rackOrderList.indexOf(b);
      if (aIndex === -1 && bIndex === -1) return a - b;
      if (aIndex === -1) return 1;
      if (bIndex === -1) return -1;
      return aIndex - bIndex;
    });

    const zones = orderedRacks.map((rack) => ({
      rack,
      items: zonesMap.get(rack)
    }));

    const noStock = withLoc.filter((i) => (i.stock ?? 0) <= 0 && i.planned_qty > 0);
    const totalToCollect = availableWithShelf.reduce((sum, i) => sum + Math.max((i.planned_qty || 0) - (i.scanned_qty || 0), 0), 0);

    res.json({
      task,
      zones,
      available: availableWithShelf.length,
      totalToCollect,
      noStock,
      noStockCount: noStock.length,
      hangingStock
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
