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

// Получение информации о товаре для печати этикетки
router.get('/:id/label-info', async (req, res) => {
  try {
    const moysklad = getMoySkladService();
    const data = await moysklad.getProductFullInfo(req.params.id);
    res.json(data);
  } catch (err) {
    console.error('Error fetching label info:', err);
    res.status(500).json({ error: err.message });
  }
});

// Получение изображения товара напрямую (проксирование через бэкенд)
// Этот эндпоинт делает запрос к МойСклад API и возвращает изображение
router.get('/:id/image', async (req, res) => {
  try {
    const db = await getDb();
    const productId = req.params.id;
    const full = req.query.full === 'true' || req.query.full === '1';
    
    // Для полноразмерного изображения всегда запрашиваем свежий URL
    const moysklad = getMoySkladService();
    let imageUrl;
    
    if (full) {
      imageUrl = await moysklad.getProductImageUrl(productId, true);
    } else {
      // Проверяем есть ли закэшированный URL в БД
      const product = db.prepare('SELECT image_url FROM products WHERE id = ?').get(productId);
      imageUrl = product?.image_url;
      
      // Если нет URL в БД, получаем его из МойСклад и кэшируем
      if (!imageUrl) {
        imageUrl = await moysklad.getProductImageUrl(productId);
        
        if (imageUrl) {
          // Сохраняем URL в БД для будущих запросов
          db.prepare('UPDATE products SET image_url = ? WHERE id = ?').run(imageUrl, productId);
        }
      }
    }
    
    if (!imageUrl) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    // Скачиваем изображение через МойСклад API (с авторизацией)
    const image = await moysklad.downloadImage(imageUrl);
    
    if (!image) {
      // URL устарел, пробуем получить новый
      const newUrl = await moysklad.getProductImageUrl(productId, full);
      if (newUrl && newUrl !== imageUrl) {
        if (!full) {
          db.prepare('UPDATE products SET image_url = ? WHERE id = ?').run(newUrl, productId);
        }
        const newImage = await moysklad.downloadImage(newUrl);
        if (newImage) {
          res.setHeader('Content-Type', newImage.contentType);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.send(Buffer.from(newImage.data));
        }
      }
      return res.status(404).json({ error: 'Image not found' });
    }

    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Кэш 24 часа
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
    let slotsSyncCompleted = false;
    const existingCellById = new Map();
    try {
      const rows = db.prepare('SELECT id, cell_address, slot_id FROM products').all();
      for (const r of rows) {
        if (r?.id) existingCellById.set(String(r.id), { cell_address: r.cell_address || null, slot_id: r.slot_id || null });
      }
    } catch (e) {
      // ignore
    }

    try {
      // Источник склада для sync ячеек:
      // 1) app_settings.moysklad_store_id (выбор в UI)
      // 2) env (MOYSKLAD_STORE_ID / MOYSKLAD_STORE_NAME через сервис)
      let storeId = null;
      try {
        const storeSetting = db.prepare(`SELECT value FROM app_settings WHERE key = 'moysklad_store_id'`).get();
        if (storeSetting?.value) {
          storeId = String(storeSetting.value).trim();
          console.log(`[sync] storeId из app_settings: ${storeId}`);
        }
      } catch (e) {
        // app_settings может отсутствовать в старых БД
      }

      if (!storeId) {
        storeId = await moysklad.storeId();
        console.log(`[sync] storeId из env/service: ${storeId}`);
      }
      
      if (storeId) {
        const slots = await moysklad.getAllStoreSlots(storeId);
        console.log(`[sync] getAllStoreSlots вернул ${slots?.length || 0} ячеек`);
        
        const slotInfoById = new Map(); // slotId -> { name, barcode }
        for (const s of slots) {
          if (s?.id) {
            slotInfoById.set(String(s.id), { 
              name: s.name || null,
              barcode: s.barcode || null
            });
          }
        }
        console.log(`[sync] Загружено ${slotInfoById.size} ячеек в map`);
        
        // Показываем первые 3 ячейки для отладки
        let slotCount = 0;
        for (const [id, info] of slotInfoById) {
          if (slotCount++ < 3) {
            console.log(`[sync]   Ячейка: ${info.name} (id: ${id.substring(0, 8)}...)`);
          }
        }

        const ids = products.map((p) => String(p.id)).filter(Boolean);
        const assortmentHrefById = new Map();
        for (const p of products) {
          const pid = String(p?.id || '').trim();
          if (!pid) continue;
          const href = p?.meta?.href || p?.product?.meta?.href || null;
          if (href) assortmentHrefById.set(pid, href);
        }
        console.log(`[sync] Обрабатываем ${ids.length} товаров`);
        
        const chunkSize = 200;
        const bestSlotByAssortment = new Map();
        let slotRowsFetched = 0;

        for (let i = 0; i < ids.length; i += chunkSize) {
          const chunk = ids.slice(i, i + chunkSize);
          const rows = await moysklad.getSlotsCurrentForAssortments(chunk, storeId, assortmentHrefById);
          const fetched = rows?.length || 0;
          slotRowsFetched += fetched;
          console.log(`[sync] getSlotsCurrentForAssortments chunk ${i}-${i+chunk.length}: вернул ${fetched} записей`);
          
          for (const r of Array.isArray(rows) ? rows : []) {
            const aid = String(
              r?.assortmentId
              || r?.assortment?.id
              || r?.assortment?.meta?.href?.split('/').pop()
              || ''
            ).trim();
            const slotId = String(
              r?.slotId
              || r?.slot?.id
              || r?.slot?.meta?.href?.split('/').pop()
              || ''
            ).trim();
            const qty = Number(r?.stock ?? r?.quantity ?? r?.available ?? 0) || 0;
            // byslot/current может возвращать строки с нулевым остатком.
            // Такие слоты не должны попадать в маршрутный лист, иначе будут «призраки» старых ячеек.
            if (!aid || !slotId || qty <= 0) continue;
            const cur = bestSlotByAssortment.get(aid);
            if (!cur || qty > cur.qty) bestSlotByAssortment.set(aid, { slotId, qty });
          }
        }
        
        console.log(`[sync] Найдено ${bestSlotByAssortment.size} товаров с привязкой к ячейкам`);

        for (const [aid, { slotId }] of bestSlotByAssortment.entries()) {
          const slotInfo = slotInfoById.get(slotId);
          const rawName = slotInfo?.name || null;
          const normalized = normalizeSlotName(rawName);
          cellById.set(aid, { 
            cell: normalized || rawName, 
            raw: rawName, 
            slotId: slotId  // Сохраняем slotId для использования в API
          });
        }
        if (slotRowsFetched > 0) {
          slotsSyncCompleted = true;
        } else {
          console.warn('[sync] byslot/current вернул 0 строк. Сохраняем предыдущие ячейки из БД (fallback), чтобы не затирать адреса.');
        }
        console.log(`[sync] Привязано ${cellById.size} товаров к ячейкам`);
      } else {
        console.warn('[sync] storeId не определён (ни app_settings, ни env). Обновление ячеек пропущено, остаются старые значения из БД.');
        
        // Показываем первые 3 привязки для отладки
        let bindCount = 0;
        for (const [aid, info] of cellById) {
          if (bindCount++ < 3) {
            console.log(`[sync]   Товар ${aid.substring(0, 8)}... -> ${info.cell} (slot: ${info.slotId?.substring(0, 8)}...)`);
          }
        }
      }
    } catch (e) {
      console.warn('[sync] slots update skipped:', e?.message || e);
    }


    // Upsert для товаров.
    // Важно: в sql.js именованные плейсхолдеры (@id) легко ломаются, если передавать позиционные параметры.
    // Поэтому здесь используем только позиционные "?".
    // Схема: 12 колонок включая slot_id
    const insertStmt = db.prepare(
      `INSERT INTO products (
         id, name, article, barcode, sku, price, stock, image_url, meta_href, requires_marking, cell_address, slot_id
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
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
         slot_id = excluded.slot_id,
         updated_at = CURRENT_TIMESTAMP`
    );
    
    // Statements для работы со штрих-кодами
    const deleteBarcodesStmt = db.prepare('DELETE FROM product_barcodes WHERE product_id = ?');
    const insertBarcodeStmt = db.prepare(
      'INSERT OR REPLACE INTO product_barcodes (product_id, barcode, barcode_type, pack_name) VALUES (?, ?, ?, ?)'
    );

    for (const product of products) {
      const id = product.id;

      // Извлекаем штрих-коды с информацией о типе и упаковке
      const extractBarcodes = (p) => {
        const out = []; // {barcode, type, packName}
        const seen = new Set();
        
        const push = (barcode, type = null, packName = null) => {
          if (!barcode) return;
          const s = String(barcode).trim();
          if (!s || seen.has(s)) return;
          seen.add(s);
          
          // Определяем тип штрих-кода автоматически если не указан
          let detectedType = type;
          if (!detectedType) {
            if (s.toUpperCase().startsWith('OZN')) {
              detectedType = 'CODE128';
            } else if (/^\d{13}$/.test(s)) {
              detectedType = 'EAN13';
            } else if (/^\d{8}$/.test(s)) {
              detectedType = 'EAN8';
            } else {
              detectedType = 'CODE128';
            }
          }
          
          out.push({ barcode: s, type: detectedType, packName });
        };

        // Основные штрихкоды товара (не из упаковок)
        const bcs = p?.barcodes;
        if (Array.isArray(bcs)) {
          for (const b of bcs) {
            if (typeof b === 'string') push(b, null, null);
            else {
              if (b?.ean13) push(b.ean13, 'EAN13', null);
              if (b?.ean8) push(b.ean8, 'EAN8', null);
              if (b?.code128) push(b.code128, 'CODE128', null);
            }
          }
        }

        // Штрихкоды упаковок (packs) — это штрих-коды для Озон, Вайлдберриз и т.д.
        // packs может быть как массивом, так и объектом с rows
        let packsArray = [];
        if (p?.packs?.rows && Array.isArray(p.packs.rows)) {
          packsArray = p.packs.rows;
        } else if (Array.isArray(p?.packs)) {
          packsArray = p.packs;
        } else if (p?.pack) {
          packsArray = [p.pack];
        }
        
        for (const pack of packsArray) {
          const packName = pack?.name || null; // Название упаковки (например "Упаковка (ШК) Ozon")
          
          // Штрих-код упаковки
          if (pack?.barcode) {
            push(pack.barcode, null, packName);
          }
          
          // Массив штрих-кодов упаковки
          const pb = pack?.barcodes;
          if (Array.isArray(pb)) {
            for (const b of pb) {
              if (typeof b === 'string') push(b, null, packName);
              else {
                if (b?.ean13) push(b.ean13, 'EAN13', packName);
                if (b?.ean8) push(b.ean8, 'EAN8', packName);
                if (b?.code128) push(b.code128, 'CODE128', packName);
              }
            }
          }
        }

        return out;
      };

      const allBarcodesWithInfo = extractBarcodes(product);
      const allBarcodes = allBarcodesWithInfo.map(b => b.barcode);
      const primaryBarcode = allBarcodes[0] || '';

      // Получаем URL миниатюры изображения
      // МойСклад: у товара есть поле image (миниатюра) и images (массив)
      // Поле image.meta.downloadHref - прямая ссылка на скачивание миниатюры
      let imageUrl = null;
      
      // Логируем структуру первых 3 товаров для отладки
      if (products.indexOf(product) < 3) {
        console.log(`[sync] Product ${product.name?.substring(0,30)}:`);
        console.log('  - image:', JSON.stringify(product.image || null));
        console.log('  - images.meta:', JSON.stringify(product.images?.meta || null));
        console.log('  - images.rows[0]:', JSON.stringify(product.images?.rows?.[0] || null));
      }
      
      // 1) Поле image (основная миниатюра товара) - самый надёжный способ
      if (product.image?.meta?.downloadHref) {
        imageUrl = product.image.meta.downloadHref;
      } else if (product.image?.meta?.href) {
        // href можно преобразовать в downloadHref добавив /download в конец
        imageUrl = product.image.meta.href;
      }
      
      // 2) Поле miniature внутри image
      if (!imageUrl && product.image?.miniature?.downloadHref) {
        imageUrl = product.image.miniature.downloadHref;
      } else if (!imageUrl && product.image?.miniature?.href) {
        imageUrl = product.image.miniature.href;
      }
      
      // 3) Массив images (если expand=images сработал)
      if (!imageUrl && product.images?.rows?.length > 0) {
        const img = product.images.rows[0];
        imageUrl = img.miniature?.downloadHref 
          || img.miniature?.href 
          || img.tiny?.downloadHref 
          || img.tiny?.href 
          || img.meta?.downloadHref
          || null;
      }
      
      // 4) Для variants - изображение может быть в product.product.image
      const baseProduct = product.product || {};
      if (!imageUrl && baseProduct.image?.meta?.downloadHref) {
        imageUrl = baseProduct.image.meta.downloadHref;
      } else if (!imageUrl && baseProduct.image?.meta?.href) {
        imageUrl = baseProduct.image.meta.href;
      }
      
      // Логируем найденный URL
      if (products.indexOf(product) < 3) {
        console.log('  => imageUrl:', imageUrl || 'NOT FOUND');
      }

      // Для variant часть полей может быть в product.product
      const base = product.product || {};
      const name = product.name || base.name || '';
      const article = product.article || base.article || '';
      const sku = product.code || base.code || '';

      // Проверяем требуется ли маркировка
      const requiresMarking = product.trackingType && product.trackingType !== 'NOT_TRACKED' ? 1 : 0;

      // Адрес ячейки (из отчёта остатков по ячейкам). Берём наиболее "значимую" ячейку (с максимальным qty).
      const cellInfo = cellById.get(id);
      const existingInfo = existingCellById.get(id);
      const cellAddress = slotsSyncCompleted
        ? (cellInfo?.cell ?? null)
        : (cellInfo?.cell ?? existingInfo?.cell_address ?? null);
      const slotId = slotsSyncCompleted
        ? (cellInfo?.slotId ?? null)
        : (cellInfo?.slotId ?? existingInfo?.slot_id ?? null);

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
        cellAddress,
        slotId
      );

      // Обновляем таблицу дополнительных штрихкодов
      try {
        deleteBarcodesStmt.run(id);
        for (const bcInfo of allBarcodesWithInfo) {
          insertBarcodeStmt.run(id, bcInfo.barcode, bcInfo.type || null, bcInfo.packName || null);
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

    // Считаем сколько товаров получили изображения
    const imageCountResult = db.prepare('SELECT COUNT(*) as cnt FROM products WHERE image_url IS NOT NULL AND image_url != ""').get();
    const imageCount = imageCountResult?.cnt || 0;
    console.log(`[sync] Products with images: ${imageCount} / ${products.length}`);

    await logAction('sync_completed', 'products', null, { products: products.length, orders: orders.length, withImages: imageCount });

    res.json({ 
      success: true, 
      productsCount: products.length,
      ordersCount: orders.length,
      withImages: imageCount,
      message: `Синхронизировано: ${products.length} товаров, ${orders.length} заказов, ${imageCount} с фото`
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
