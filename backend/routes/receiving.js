import { Router } from 'express';
import { getDb, logAction } from '../database.js';
import { getMoySkladService } from '../services/moysklad.js';

const router = Router();

// Получение заказов поставщикам
router.get('/orders', async (req, res) => {
  try {
    const db = await getDb();
    const orders = db.prepare(`
      SELECT po.*, 
        (SELECT COUNT(*) FROM purchase_order_items WHERE order_id = po.id) as items_count,
        (SELECT SUM(ordered_qty) FROM purchase_order_items WHERE order_id = po.id) as total_qty
      FROM purchase_orders po
      ORDER BY po.moment DESC
      LIMIT 100
    `).all();

    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение деталей заказа поставщику
router.get('/orders/:id', async (req, res) => {
  try {
    const db = await getDb();
    const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const items = db.prepare(`
      SELECT poi.*, p.name, p.barcode, p.article, p.image_url, p.sku
      FROM purchase_order_items poi
      JOIN products p ON p.id = poi.product_id
      WHERE poi.order_id = ?
    `).all(req.params.id);

    res.json({ ...order, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение списка сессий приемки
router.get('/sessions', async (req, res) => {
  try {
    const db = await getDb();
    const sessions = db.prepare(`
      SELECT rs.*, po.name as order_name, po.supplier_name
      FROM receiving_sessions rs
      LEFT JOIN purchase_orders po ON po.id = rs.purchase_order_id
      ORDER BY rs.created_at DESC
    `).all();

    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получение сессии с деталями
router.get('/sessions/:id', async (req, res) => {
  try {
    const db = await getDb();
    const session = db.prepare(`
      SELECT rs.*, po.name as order_name, po.supplier_name
      FROM receiving_sessions rs
      LEFT JOIN purchase_orders po ON po.id = rs.purchase_order_id
      WHERE rs.id = ?
    `).get(req.params.id);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const items = db.prepare(`
      SELECT ri.*, p.name, p.barcode, p.article, p.image_url, p.sku, p.meta_href, p.price
      FROM receiving_items ri
      JOIN products p ON p.id = ri.product_id
      WHERE ri.session_id = ?
      ORDER BY ri.is_extra ASC, p.name ASC
    `).all(req.params.id);

    res.json({ ...session, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Создание сессии приемки на основе заказа поставщику
router.post('/sessions', async (req, res) => {
  try {
    const db = await getDb();
    const { purchaseOrderId } = req.body;

    let sessionName = `Приемка ${new Date().toLocaleDateString('ru')}`;
    let totalOrdered = 0;

    const result = db.prepare(`
      INSERT INTO receiving_sessions (purchase_order_id, name, total_ordered)
      VALUES (?, ?, ?)
    `).run(purchaseOrderId || null, sessionName, 0);

    const sessionId = result.lastInsertRowid;

    // Если есть заказ поставщику - копируем позиции
    if (purchaseOrderId) {
      const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(purchaseOrderId);
      if (order) {
        sessionName = `Приемка: ${order.name}`;
        
        const orderItems = db.prepare(`
          SELECT * FROM purchase_order_items WHERE order_id = ?
        `).all(purchaseOrderId);

        const insertItem = db.prepare(`
          INSERT INTO receiving_items (session_id, product_id, ordered_qty, is_extra)
          VALUES (?, ?, ?, 0)
        `);

        for (const item of orderItems) {
          insertItem.run(sessionId, item.product_id, item.ordered_qty);
          totalOrdered += item.ordered_qty;
        }

        db.prepare(`
          UPDATE receiving_sessions SET name = ?, total_ordered = ? WHERE id = ?
        `).run(sessionName, totalOrdered, sessionId);
      }
    }

    await logAction('receiving_session_created', 'receiving_session', sessionId, { purchaseOrderId });

    res.json({ success: true, sessionId, name: sessionName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Сканирование товара при приемке
router.post('/sessions/:id/scan', async (req, res) => {
  try {
    const db = await getDb();
    const sessionId = req.params.id;
    const { barcode, quantity = 1 } = req.body;

    const session = db.prepare('SELECT * FROM receiving_sessions WHERE id = ?').get(sessionId);
    if (!session || session.status !== 'active') {
      return res.status(400).json({ error: 'Session not active' });
    }

    const product = db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode);
    if (!product) {
      return res.status(404).json({ error: 'Product not found', barcode });
    }

    // Проверяем есть ли товар в списке
    const item = db.prepare(`
      SELECT * FROM receiving_items WHERE session_id = ? AND product_id = ?
    `).get(sessionId, product.id);

    let itemId;
    let prevQty = 0;

    if (item) {
      // Обновляем количество
      prevQty = item.received_qty;
      db.prepare(`
        UPDATE receiving_items SET received_qty = received_qty + ? WHERE id = ?
      `).run(quantity, item.id);
      itemId = item.id;
    } else {
      // Товар не в заказе - это пересорт/излишек
      const result = db.prepare(`
        INSERT INTO receiving_items (session_id, product_id, ordered_qty, received_qty, defect_qty, is_extra)
        VALUES (?, ?, 0, ?, 0, 1)
      `).run(sessionId, product.id, quantity);
      itemId = result.lastInsertRowid;
    }

    // Сохраняем информацию о последнем сканировании для возможности отмены
    db.prepare(`
      UPDATE receiving_sessions 
      SET total_received = (SELECT SUM(received_qty) FROM receiving_items WHERE session_id = ?),
          last_scan_item_id = ?,
          last_scan_qty = ?,
          last_scan_prev_qty = ?
      WHERE id = ?
    `).run(sessionId, itemId, quantity, prevQty, sessionId);

    const updatedItem = db.prepare(`
      SELECT ri.*, p.name FROM receiving_items ri
      JOIN products p ON p.id = ri.product_id
      WHERE ri.session_id = ? AND ri.product_id = ?
    `).get(sessionId, product.id);

    res.json({
      success: true,
      product: product.name,
      ordered: updatedItem.ordered_qty,
      received: updatedItem.received_qty,
      isExtra: updatedItem.is_extra === 1,
      canUndo: true
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Отмена последнего сканирования
router.post('/sessions/:id/undo', async (req, res) => {
  try {
    const db = await getDb();
    const sessionId = req.params.id;

    const session = db.prepare('SELECT * FROM receiving_sessions WHERE id = ?').get(sessionId);
    if (!session || session.status !== 'active') {
      return res.status(400).json({ error: 'Session not active' });
    }

    if (!session.last_scan_item_id) {
      return res.status(400).json({ error: 'Нечего отменять' });
    }

    const item = db.prepare('SELECT ri.*, p.name FROM receiving_items ri JOIN products p ON p.id = ri.product_id WHERE ri.id = ?')
      .get(session.last_scan_item_id);

    if (!item) {
      return res.status(400).json({ error: 'Item not found' });
    }

    // Если это был новый товар (пересорт) и qty = last_scan_qty, удаляем
    if (item.is_extra === 1 && item.received_qty === session.last_scan_qty) {
      db.prepare('DELETE FROM receiving_items WHERE id = ?').run(session.last_scan_item_id);
    } else {
      // Иначе восстанавливаем предыдущее количество
      db.prepare('UPDATE receiving_items SET received_qty = ? WHERE id = ?')
        .run(session.last_scan_prev_qty, session.last_scan_item_id);
    }

    // Очищаем информацию о последнем сканировании
    db.prepare(`
      UPDATE receiving_sessions 
      SET total_received = (SELECT COALESCE(SUM(received_qty), 0) FROM receiving_items WHERE session_id = ?),
          last_scan_item_id = NULL,
          last_scan_qty = NULL,
          last_scan_prev_qty = NULL
      WHERE id = ?
    `).run(sessionId, sessionId);

    res.json({
      success: true,
      message: `Отменено: ${item.name}`,
      undoneQty: session.last_scan_qty
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ручное обновление количества
router.patch('/sessions/:id/items/:itemId', async (req, res) => {
  try {
    const db = await getDb();
    const { id: sessionId, itemId } = req.params;
    const { received_qty, defect_qty } = req.body;

    if (received_qty !== undefined && received_qty < 0) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    if (received_qty !== undefined) {
      db.prepare('UPDATE receiving_items SET received_qty = ? WHERE id = ? AND session_id = ?')
        .run(received_qty, itemId, sessionId);
    }

    if (defect_qty !== undefined) {
      db.prepare('UPDATE receiving_items SET defect_qty = ? WHERE id = ? AND session_id = ?')
        .run(Math.max(0, defect_qty), itemId, sessionId);
    }

    db.prepare(`
      UPDATE receiving_sessions 
      SET total_received = (SELECT SUM(received_qty) FROM receiving_items WHERE session_id = ?)
      WHERE id = ?
    `).run(sessionId, sessionId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Установка брака для позиции
router.post('/sessions/:id/items/:itemId/defect', async (req, res) => {
  try {
    const db = await getDb();
    const { id: sessionId, itemId } = req.params;
    const { defect_qty } = req.body;

    const item = db.prepare('SELECT * FROM receiving_items WHERE id = ? AND session_id = ?').get(itemId, sessionId);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    db.prepare('UPDATE receiving_items SET defect_qty = ? WHERE id = ?')
      .run(Math.max(0, defect_qty || 0), itemId);

    const product = db.prepare('SELECT name, article FROM products WHERE id = ?').get(item.product_id);

    res.json({ 
      success: true, 
      product: product?.name,
      article: product?.article,
      defect_qty 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Добавление товара (пересорт)
router.post('/sessions/:id/items', async (req, res) => {
  try {
    const db = await getDb();
    const sessionId = req.params.id;
    const { productId, quantity, isExtra = true } = req.body;

    const session = db.prepare('SELECT * FROM receiving_sessions WHERE id = ?').get(sessionId);
    if (!session || session.status !== 'active') {
      return res.status(400).json({ error: 'Session not active' });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Проверяем нет ли уже
    const existing = db.prepare(`
      SELECT * FROM receiving_items WHERE session_id = ? AND product_id = ?
    `).get(sessionId, productId);

    if (existing) {
      db.prepare(`
        UPDATE receiving_items SET received_qty = received_qty + ? WHERE id = ?
      `).run(quantity, existing.id);
    } else {
      // isExtra = true означает пересорт (не было в заказе)
      db.prepare(`
        INSERT INTO receiving_items (session_id, product_id, ordered_qty, received_qty, defect_qty, is_extra)
        VALUES (?, ?, 0, ?, 0, ?)
      `).run(sessionId, productId, quantity, isExtra ? 1 : 0);
    }

    db.prepare(`
      UPDATE receiving_sessions 
      SET total_received = (SELECT SUM(received_qty) FROM receiving_items WHERE session_id = ?)
      WHERE id = ?
    `).run(sessionId, sessionId);

    res.json({ success: true, product: product.name, quantity, isExtra });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Завершение приемки
router.post('/sessions/:id/complete', async (req, res) => {
  try {
    const db = await getDb();
    const sessionId = req.params.id;

    const session = db.prepare(`
      SELECT rs.*, 
        po.meta_href as order_href,
        po.agent_meta,
        po.organization_meta,
        po.store_meta,
        po.name as order_name
      FROM receiving_sessions rs
      LEFT JOIN purchase_orders po ON po.id = rs.purchase_order_id
      WHERE rs.id = ?
    `).get(sessionId);

    if (!session || session.status !== 'active') {
      return res.status(400).json({ error: 'Session not active' });
    }

    // Получаем все позиции с данными о товарах
    const items = db.prepare(`
      SELECT ri.*, p.meta_href, p.price, p.name, p.article
      FROM receiving_items ri
      JOIN products p ON p.id = ri.product_id
      WHERE ri.session_id = ?
    `).all(sessionId);

    const receivedItems = items.filter(i => i.received_qty > 0);

    if (receivedItems.length === 0) {
      return res.status(400).json({ error: 'No items received' });
    }

    const moysklad = getMoySkladService();

    // Разделяем на основную поставку и пересорт
    const mainItems = receivedItems.filter(i => i.is_extra === 0);
    const extraItems = receivedItems.filter(i => i.is_extra === 1);
    
    // Собираем информацию о браке для комментария
    const defectItems = items.filter(i => i.defect_qty > 0);
    let defectComment = '';
    if (defectItems.length > 0) {
      defectComment = 'БРАК:\n' + defectItems.map(d => 
        `• ${d.article || d.name}: ${d.defect_qty} шт`
      ).join('\n');
    }

    let supplyId = null;
    let enterId = null;

    // Создаем приемку (supply) для основных товаров
    if (mainItems.length > 0) {
      const supplyPositions = mainItems.map(item => ({
        quantity: item.received_qty,
        price: item.price || 0,
        productHref: item.meta_href
      }));

      // Используем данные из заказа поставщику или по умолчанию
      let agentMeta = null;
      let organizationMeta = null;
      let storeMeta = null;
      let purchaseOrderMeta = null;

      if (session.purchase_order_id) {
        // Строго берём из заказа поставщику
        if (session.agent_meta) agentMeta = JSON.parse(session.agent_meta);
        if (session.organization_meta) organizationMeta = JSON.parse(session.organization_meta);
        if (session.store_meta) storeMeta = JSON.parse(session.store_meta);
        if (session.order_href) {
          purchaseOrderMeta = {
            href: session.order_href,
            type: 'purchaseorder',
            mediaType: 'application/json'
          };
        }
      }

      // Если нет данных из заказа - берём по умолчанию
      if (!organizationMeta) {
        const org = await moysklad.getDefaultOrganization();
        organizationMeta = org.meta;
      }
      if (!storeMeta) {
        const store = await moysklad.getDefaultStore();
        storeMeta = store.meta;
      }
      if (!agentMeta) {
        const agent = await moysklad.getDefaultAgent();
        if (agent) agentMeta = agent.meta;
      }

      if (!agentMeta) {
        return res.status(400).json({ error: 'Не найден контрагент для приёмки' });
      }

      const supply = await moysklad.createSupplyDirect({
        positions: supplyPositions,
        agentMeta,
        organizationMeta,
        storeMeta,
        purchaseOrderMeta,
        description: defectComment || undefined
      });
      supplyId = supply.id;
    }

    // Создаем оприходование (enter) для пересорта/излишков
    if (extraItems.length > 0) {
      const enterPositions = extraItems.map(item => ({
        quantity: item.received_qty,
        price: item.price || 0,
        productHref: item.meta_href
      }));

      // Для оприходования используем организацию и склад из заказа или по умолчанию
      let organizationMeta = session.organization_meta ? JSON.parse(session.organization_meta) : null;
      let storeMeta = session.store_meta ? JSON.parse(session.store_meta) : null;

      if (!organizationMeta) {
        const org = await moysklad.getDefaultOrganization();
        organizationMeta = org.meta;
      }
      if (!storeMeta) {
        const store = await moysklad.getDefaultStore();
        storeMeta = store.meta;
      }

      const enter = await moysklad.createEnterDirect({
        positions: enterPositions,
        organizationMeta,
        storeMeta,
        description: 'Пересорт при приемке'
      });
      enterId = enter.id;
    }

    // Обновляем сессию
    db.prepare(`
      UPDATE receiving_sessions 
      SET status = 'completed', completed_at = datetime('now'), supply_id = ?, enter_id = ?
      WHERE id = ?
    `).run(supplyId, enterId, sessionId);

    await logAction('receiving_completed', 'receiving_session', sessionId, { supplyId, enterId });

    res.json({
      success: true,
      supplyId,
      enterId,
      message: `Приемка завершена${supplyId ? '. Приемка создана' : ''}${enterId ? '. Оприходование создано' : ''}`
    });

  } catch (error) {
    console.error('Complete receiving error:', error);
    res.status(500).json({ error: 'Failed to complete', message: error.message });
  }
});

// Отмена сессии
router.post('/sessions/:id/cancel', async (req, res) => {
  try {
    const db = await getDb();
    db.prepare(`UPDATE receiving_sessions SET status = 'cancelled' WHERE id = ? AND status = 'active'`)
      .run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
