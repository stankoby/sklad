import axios from 'axios';

const BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';

class MoySkladService {
  constructor() {
    const token = process.env.MOYSKLAD_TOKEN;
    const login = process.env.MOYSKLAD_LOGIN;
    const password = process.env.MOYSKLAD_PASSWORD;
    
    let authHeader;
    
    if (token) {
      authHeader = `Bearer ${token}`;
    } else if (login && password) {
      const base64 = Buffer.from(`${login}:${password}`).toString('base64');
      authHeader = `Basic ${base64}`;
    } else {
      throw new Error('MOYSKLAD_TOKEN или MOYSKLAD_LOGIN + MOYSKLAD_PASSWORD не настроены');
    }
    
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'Authorization': authHeader,
        // МойСклад в некоторых конфигурациях/прокси отвечает 415, если не указан Content-Type даже на GET.
        // Также встречались 400 при Accept-Encoding с br, поэтому явно просим gzip.
        'Accept': 'application/json;charset=utf-8',
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
      }
    });

    // В axios/Node по умолчанию может добавляться широкий Accept-Encoding (включая br).
    // Мы фиксируем gzip выше в headers, но на всякий случай не даём переопределять его ниже.
    this.client.interceptors.request.use((config) => {
      config.headers = config.headers || {};
      if (!config.headers['Accept-Encoding']) {
        config.headers['Accept-Encoding'] = 'gzip';
      }
      if (!config.headers['Content-Type']) {
        config.headers['Content-Type'] = 'application/json';
      }
      if (!config.headers['Accept']) {
        config.headers['Accept'] = 'application/json';
      }
      return config;
    });

    this._resolvedStoreId = null;
  }

  /**
   * Возвращает ID склада, с которым работаем.
   *
   * Приоритет:
   * 1) MOYSKLAD_STORE_ID (uuid)
   * 2) MOYSKLAD_STORE_NAME (точное имя склада, включая точку в конце)
   */
  async storeId() {
    if (this._resolvedStoreId) return this._resolvedStoreId;

    const directId = (process.env.MOYSKLAD_STORE_ID || '').trim();
    if (directId) {
      this._resolvedStoreId = directId;
      return directId;
    }

    const storeName = (process.env.MOYSKLAD_STORE_NAME || '').trim();
    if (!storeName) {
      // не задано — оставляем null, вызывающий код должен обработать
      return null;
    }

    // Ищем склад по имени
    const res = await this.client.get('/entity/store', { params: { limit: 1000 } });
    const row = (res.data?.rows || []).find((s) => s?.name === storeName);
    const id = row?.id || null;
    this._resolvedStoreId = id;
    return id;
  }


  async findStoreHref(storeName) {
    const name = (storeName || '').trim();
    if (!name) return null;

    const stores = [];
    let offset = 0;
    const limit = 1000;
    while (true) {
      const r = await this.client.get('/entity/store', { params: { offset, limit } });
      const part = r.data?.rows || [];
      stores.push(...part);
      if (part.length < limit) break;
      offset += limit;
    }
    const found = stores.find(s => String(s?.name || '').trim() === name);
    return found?.meta?.href || null;
  }

  async checkConnection() {
    try {
      const response = await this.client.get('/entity/employee', { params: { limit: 1 } });
      return { connected: true, user: response.data.rows[0]?.name };
    } catch (error) {
      return { connected: false, error: error.message };
    }
  }

  // Получение всех товаров с информацией о маркировке
  async getAllProducts() {
    // В МойСклад товары могут быть как "product", так и "variant" (модификации),
    // и штрихкоды часто находятся именно на модификациях или упаковках.
    // Для корректных остатков и поиска по штрихкоду подтягиваем оба типа.
    const rows = [];
    const limit = 1000;

    const fetchAll = async (path, params = {}) => {
      let offset = 0;
      while (true) {
        const response = await this.client.get(path, { params: { offset, limit, ...params } });
        const part = response.data?.rows || [];
        rows.push(...part);
        if (part.length < limit) break;
        offset += limit;
      }
    };

    // Базовые товары с изображениями и упаковками
    // expand=image - получаем миниатюру основного изображения
    // expand=images - получаем все изображения (может быть избыточно)
    // expand=packs - получаем штрих-коды упаковок (для Озон, Вайлдберриз и т.д.)
    await fetchAll('/entity/product', { expand: 'image,images,packs' });

    // Модификации (variants) с изображениями
    await fetchAll('/entity/variant', { expand: 'image,images,product.image,product.packs' });

    return rows;
  }

  // Получение остатков
  async getStock() {
    // Ключевой нюанс вашего учёта: остатки смотрите по конкретному складу “Склад хранения.”
    // Если не ограничить склад, МойСклад может возвращать агрегат/другой срез, и маппинг в UI будет «0».
    // Поэтому:
    //  1) если задан MOYSKLAD_STORE_NAME — ищем склад по имени
    //  2) пытаемся получить остатки через /report/stock/all с фильтром по складу
    //  3) если фильтр не поддержан — используем /report/stock/bystore и выбираем нужный склад

    const stockMode = process.env.MOYSKLAD_STOCK_MODE || 'all';
    // Ваш кейс: основной склад называется "Склад хранения." (с точкой).
    // Если переменная не задана, берём это значение по умолчанию, чтобы не получать «0» из-за другого склада.
    const storeName = (process.env.MOYSKLAD_STORE_NAME || 'Склад хранения.').trim();

    let storeHref = null;
    if (storeName) {
      // Ищем склад по точному имени (включая точку в конце, если она есть)
      const stores = [];
      let offset = 0;
      const limit = 1000;
      while (true) {
        const r = await this.client.get('/entity/store', { params: { offset, limit } });
        const part = r.data?.rows || [];
        stores.push(...part);
        if (part.length < limit) break;
        offset += limit;
      }
      const found = stores.find(s => String(s?.name || '').trim() === storeName);
      if (found?.meta?.href) storeHref = found.meta.href;
    }

    // Helper: paginated fetch for report endpoints
    const fetchReportAll = async (path, params) => {
      const rows = [];
      let offset = 0;
      const limit = 1000;
      while (true) {
        const resp = await this.client.get(path, { params: { offset, limit, ...params } });
        const part = resp.data?.rows || [];
        rows.push(...part);
        if (part.length < limit) break;
        offset += limit;
      }
      return rows;
    };

    // 1) Пытаемся /report/stock/all (самый удобный формат) + expand=assortment
    // Фильтр в МойСклад передаётся строкой: filter=store=<href>;stockMode=<mode>
    // (пример формата фильтра для bystore: turn1search2).
    try {
      const params = { stockMode, expand: 'assortment' };
      if (storeHref) {
        params.filter = `store=${storeHref}`;
      }
      return await fetchReportAll('/report/stock/all', params);
    } catch (e) {
      // 2) Фолбэк: /report/stock/bystore
      // Здесь rows обычно содержат meta.href (товар/ассортимент) и массив stockByStore.
      const params = { stockMode };
      if (storeHref) {
        params.filter = `store=${storeHref};stockMode=${stockMode}`;
      } else {
        params.filter = `stockMode=${stockMode}`;
      }
      const rows = await fetchReportAll('/report/stock/bystore', params);

      // Приводим формат к «как будто /stock/all»: делаем строки с assortment/meta и полем stock.
      const normalized = [];
      for (const r of rows) {
        // В bystore есть stockByStore: [{name, stock, reserve, ...}]
        const by = Array.isArray(r?.stockByStore) ? r.stockByStore : [];
        let picked = null;
        if (storeName) {
          picked = by.find(x => String(x?.name || '').trim() === storeName) || null;
        }
        // если склад не задан — суммируем по всем складам
        const stockVal = picked ? (picked.stock ?? picked.quantity ?? 0) : by.reduce((acc, x) => acc + Number(x?.stock ?? x?.quantity ?? 0), 0);

        normalized.push({
          assortment: { meta: r?.meta },
          stock: stockVal,
          available: picked?.available,
          free: picked?.free,
          reserve: picked?.reserve,
          quantity: picked?.quantity,
          // на всякий случай пробрасываем штрихкоды, если они есть
          barcodes: r?.barcodes,
        });
      }
      return normalized;
    }
  }



  
  // Остатки по "ячейкам" (слотам) для конкретных товаров.
  //
  // Важно: в API МойСклад это отдельный отчёт:
  //   GET /report/stock/byslot/current?filter=assortmentId=<uuid,uuid>;storeId=<uuid>
  // Без assortmentId отчёт не работает (так устроено API), поэтому вызываем его
  // точечно — только для товаров в задаче.
  async getSlotsCurrentForAssortments(assortmentIds, storeId = null) {
    const ids = (assortmentIds || []).map((x) => String(x).trim()).filter(Boolean);
    if (!ids.length) return [];

    // Определяем склад
    let sid = storeId ? String(storeId).trim() : '';
    if (!sid) {
      const storeName = (process.env.MOYSKLAD_STORE_NAME || 'Склад хранения.').trim();
      const storeHref = await this.findStoreHref(storeName);
      if (storeHref) sid = String(storeHref).split('/').pop();
    }
    if (!sid) {
      throw new Error('Не удалось определить storeId. Укажите MOYSKLAD_STORE_NAME или MOYSKLAD_STORE_ID');
    }

    const storeHref = `${BASE_URL}/entity/store/${sid}`;
    const chunkSize = Number(process.env.MOYSKLAD_SLOT_CHUNK_SIZE || 30);

    const chunks = [];
    for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));

    const allRows = [];
    const seen = new Set();

    const parseIdFromHref = (href) => String(href || '').split('/').pop();
    const getAid = (row) => String(
      row?.assortmentId
      || row?.assortment?.id
      || parseIdFromHref(row?.assortment?.meta?.href)
      || parseIdFromHref(row?.meta?.href)
      || ''
    ).trim();

    const getSlotId = (row) => String(
      row?.slotId
      || row?.slot?.id
      || parseIdFromHref(row?.slot?.meta?.href)
      || ''
    ).trim();

    const pushRows = (rows, chunkSet) => {
      let pushed = 0;
      for (const row of Array.isArray(rows) ? rows : []) {
        const aid = getAid(row);
        const slotId = getSlotId(row);
        if (!aid || !slotId || !chunkSet.has(aid)) continue;

        const qty = Number(row?.stock ?? row?.quantity ?? row?.available ?? 0) || 0;
        const uniq = `${aid}|${slotId}|${qty}`;
        if (seen.has(uniq)) continue;
        seen.add(uniq);
        allRows.push(row);
        pushed += 1;
      }
      return pushed;
    };

    for (const chunk of chunks) {
      const chunkSet = new Set(chunk);
      let gotForChunk = 0;

      const idsCsv = chunk.join(',');
      const assortmentHrefCsv = chunk.map((id) => `${BASE_URL}/entity/product/${id}`).join(',');
      const assortmentHrefVariantCsv = chunk.map((id) => `${BASE_URL}/entity/variant/${id}`).join(',');

      const filterCandidates = [
        `assortmentId=${idsCsv};storeId=${sid}`,
        `${chunk.map((id) => `assortmentId=${id}`).join(';')};storeId=${sid}`,
        `assortmentId=${idsCsv};store=${storeHref}`,
        `${chunk.map((id) => `assortmentId=${id}`).join(';')};store=${storeHref}`,
        `assortment=${assortmentHrefCsv};store=${storeHref}`,
        `assortment=${assortmentHrefVariantCsv};store=${storeHref}`,
      ];

      for (const filter of filterCandidates) {
        try {
          const resp = await this.client.get('/report/stock/byslot/current', {
            params: { filter, limit: 1000 }
          });
          const rows = resp.data?.rows || [];
          const pushed = pushRows(rows, chunkSet);
          gotForChunk += pushed;
          if (pushed > 0) break;
        } catch (err) {
          // пробуем следующий формат
        }
      }

      if (gotForChunk === 0) {
        // Фолбэк: запрос по одному assortmentId в двух вариантах store-параметра
        for (const aid of chunk) {
          const oneByIdFilters = [
            `assortmentId=${aid};storeId=${sid}`,
            `assortmentId=${aid};store=${storeHref}`,
          ];

          for (const filter of oneByIdFilters) {
            try {
              const resp = await this.client.get('/report/stock/byslot/current', {
                params: { filter, limit: 1000 }
              });
              const rows = resp.data?.rows || [];
              const pushed = pushRows(rows, chunkSet);
              if (pushed > 0) break;
            } catch (err) {
              // continue
            }
          }
        }
      }
    }

    return allRows;
  }


  // Получить все ячейки (slots) выбранного склада.
  // Важно: тип slot в API не доступен по /entity/slot, только через /entity/store/{storeId}/slots.
  async getAllStoreSlots(storeId = null) {
    const sid = (storeId ? String(storeId).trim() : '') || (await this.storeId());
    if (!sid) throw new Error('MOYSKLAD_STORE_ID/MOYSKLAD_STORE_NAME не настроены');

    const limit = 1000;
    let offset = 0;
    const rows = [];

    while (true) {
      const res = await this.client.get(`/entity/store/${sid}/slots`, {
        params: { limit, offset },
      });
      const part = res.data?.rows || [];
      rows.push(...part);
      if (part.length < limit) break;
      offset += limit;
    }

    return rows;
  }

  // Map(slotId -> slotName)
  async getStoreSlotNameMap(storeId = null) {
    const rows = await this.getAllStoreSlots(storeId);
    const map = new Map();
    for (const r of rows) {
      if (r?.id) map.set(r.id, r?.name || '');
    }
    return map;
  }

  // Получение заказов поставщикам
  async getPurchaseOrders() {
    const orders = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await this.client.get('/entity/purchaseorder', {
        params: {
          offset,
          limit,
          expand: 'agent,positions',
          filter: 'applicable=true',
          order: 'moment,desc'
        }
      });

      orders.push(...response.data.rows);

      if (response.data.rows.length < limit) break;
      offset += limit;
      
      // Ограничиваем 500 заказами
      if (orders.length >= 500) break;
    }

    return orders;
  }

  // Получение позиций заказа поставщику
  async getPurchaseOrderPositions(orderId) {
    const response = await this.client.get(`/entity/purchaseorder/${orderId}/positions`, {
      params: { expand: 'assortment' }
    });
    return response.data.rows;
  }

  // Получение первого склада
  async getDefaultStore() {
    const response = await this.client.get('/entity/store', { params: { limit: 1 } });
    return response.data.rows[0];
  }

  // Получение первой организации
  async getDefaultOrganization() {
    const response = await this.client.get('/entity/organization', { params: { limit: 1 } });
    return response.data.rows[0];
  }

  // Создание отгрузки (demand)
  async createShipment(items, store, organization) {
    const positions = items.map(item => ({
      quantity: item.quantity,
      price: (item.price || 0) * 100,
      assortment: {
        meta: {
          href: item.productHref,
          type: 'product',
          mediaType: 'application/json'
        }
      }
    }));

    const response = await this.client.post('/entity/demand', {
      organization: {
        meta: {
          href: organization.meta.href,
          type: 'organization',
          mediaType: 'application/json'
        }
      },
      store: {
        meta: {
          href: store.meta.href,
          type: 'store',
          mediaType: 'application/json'
        }
      },
      positions
    });

    return response.data;
  }

  // Получение контрагента по умолчанию (первый поставщик)
  async getDefaultAgent() {
    const response = await this.client.get('/entity/counterparty', { 
      params: { limit: 1, filter: 'companyType=legal' } 
    });
    return response.data.rows[0];
  }

  // Создание приёмки (supply) на основе заказа поставщику
  async createSupply(purchaseOrder, items, store, organization, agent = null) {
    const positions = items.map(item => ({
      quantity: item.quantity,
      price: (item.price || 0) * 100,
      assortment: {
        meta: {
          href: item.productHref,
          type: 'product',
          mediaType: 'application/json'
        }
      }
    }));

    // Получаем контрагента
    let agentMeta = agent?.meta;
    
    if (purchaseOrder?.agent?.meta) {
      agentMeta = purchaseOrder.agent.meta;
    }
    
    if (!agentMeta) {
      // Получаем любого контрагента если не указан
      const defaultAgent = await this.getDefaultAgent();
      if (defaultAgent) {
        agentMeta = defaultAgent.meta;
      }
    }

    if (!agentMeta) {
      throw new Error('Не найден контрагент для приёмки');
    }

    const body = {
      organization: {
        meta: {
          href: organization.meta.href,
          type: 'organization',
          mediaType: 'application/json'
        }
      },
      store: {
        meta: {
          href: store.meta.href,
          type: 'store',
          mediaType: 'application/json'
        }
      },
      agent: {
        meta: agentMeta
      },
      positions
    };

    // Привязываем к заказу поставщику если есть
    if (purchaseOrder?.meta?.href) {
      body.purchaseOrder = {
        meta: {
          href: purchaseOrder.meta.href,
          type: 'purchaseorder',
          mediaType: 'application/json'
        }
      };
    }

    const response = await this.client.post('/entity/supply', body);
    return response.data;
  }

  // Создание оприходования (enter) для пересорта/излишков
  async createEnter(items, store, organization, description = '') {
    const positions = items.map(item => ({
      quantity: item.quantity,
      price: (item.price || 0) * 100,
      assortment: {
        meta: {
          href: item.productHref,
          type: 'product',
          mediaType: 'application/json'
        }
      }
    }));

    const response = await this.client.post('/entity/enter', {
      organization: {
        meta: {
          href: organization.meta.href,
          type: 'organization',
          mediaType: 'application/json'
        }
      },
      store: {
        meta: {
          href: store.meta.href,
          type: 'store',
          mediaType: 'application/json'
        }
      },
      description: description || 'Пересорт/излишки',
      positions
    });

    return response.data;
  }
  // Создание приёмки (supply) с прямым указанием meta данных
  async createSupplyDirect({ positions, agentMeta, organizationMeta, storeMeta, purchaseOrderMeta, description }) {
    const body = {
      organization: { meta: organizationMeta },
      store: { meta: storeMeta },
      agent: { meta: agentMeta },
      positions: positions.map(item => ({
        quantity: item.quantity,
        price: (item.price || 0) * 100,
        assortment: {
          meta: {
            href: item.productHref,
            type: 'product',
            mediaType: 'application/json'
          }
        }
      }))
    };

    // Добавляем комментарий если есть
    if (description) {
      body.description = description;
    }

    // Привязываем к заказу поставщику если есть
    if (purchaseOrderMeta) {
      body.purchaseOrder = { meta: purchaseOrderMeta };
    }

    const response = await this.client.post('/entity/supply', body);
    return response.data;
  }

  // Создание оприходования (enter) с прямым указанием meta данных
  async createEnterDirect({ positions, organizationMeta, storeMeta, description = '' }) {
    const body = {
      organization: { meta: organizationMeta },
      store: { meta: storeMeta },
      description: description || 'Оприходование',
      positions: positions.map(item => ({
        quantity: item.quantity,
        price: (item.price || 0) * 100,
        assortment: {
          meta: {
            href: item.productHref,
            type: 'product',
            mediaType: 'application/json'
          }
        }
      }))
    };

    const response = await this.client.post('/entity/enter', body);
    return response.data;
  }

  // Создание отгрузки (demand) - списание со склада
  async createDemand(items, store, organization, description = '') {
    const positions = items.map(item => ({
      quantity: item.quantity,
      price: (item.price || 0) * 100,
      assortment: {
        meta: {
          href: item.productHref,
          type: 'product',
          mediaType: 'application/json'
        }
      }
    }));

    // Получаем контрагента по умолчанию
    const agent = await this.getDefaultAgent();
    if (!agent) {
      throw new Error('Не найден контрагент для отгрузки');
    }

    const body = {
      organization: {
        meta: {
          href: organization.meta.href,
          type: 'organization',
          mediaType: 'application/json'
        }
      },
      store: {
        meta: {
          href: store.meta.href,
          type: 'store',
          mediaType: 'application/json'
        }
      },
      agent: {
        meta: agent.meta
      },
      description: description || 'Отгрузка со склада',
      positions
    };

    const response = await this.client.post('/entity/demand', body);
    return response.data;
  }

  // Получение контрагента по умолчанию
  async getDefaultAgent() {
    try {
      const response = await this.client.get('/entity/counterparty', {
        params: { limit: 1 }
      });
      return response.data.rows[0] || null;
    } catch (error) {
      console.error('Error getting default agent:', error.message);
      return null;
    }
  }

  async getProductImageDownload(productId) {
    if (!productId) return null;

    const response = await this.client.get(`/entity/product/${productId}/images`);
    const rows = response.data?.rows || [];
    if (rows.length === 0) return null;

    const image = rows[0];
    const href = image?.meta?.href || '';
    const idMatch = href.match(/\/([0-9a-fA-F-]{36})(?:\?.*)?$/);
    const imageId = image?.id || idMatch?.[1];
    if (!imageId) return null;

    const downloadResponse = await this.client.get(`/download/${imageId}`, {
      responseType: 'arraybuffer'
    });

    return {
      data: downloadResponse.data,
      contentType: downloadResponse.headers?.['content-type'] || 'image/jpeg'
    };
  }

  // Получение URL изображения товара (miniature.downloadHref)
  // Возвращает URL для скачивания миниатюры, который можно использовать через прокси
  async getProductImageUrl(productId, full = false) {
    if (!productId) return null;

    try {
      // Пробуем сначала как product
      let response;
      try {
        response = await this.client.get(`/entity/product/${productId}/images`);
      } catch (e) {
        // Если не product, пробуем как variant
        try {
          response = await this.client.get(`/entity/variant/${productId}/images`);
        } catch (e2) {
          return null;
        }
      }

      const rows = response.data?.rows || [];
      if (rows.length === 0) return null;

      const image = rows[0];
      
      // Для полноразмерного изображения используем meta.downloadHref
      // Для миниатюры используем miniature.downloadHref
      if (full) {
        const url = image?.meta?.downloadHref
          || image?.miniature?.downloadHref 
          || image?.miniature?.href 
          || null;
        return url;
      }
      
      // Для миниатюры (по умолчанию)
      const url = image?.miniature?.downloadHref 
        || image?.miniature?.href 
        || image?.tiny?.downloadHref
        || image?.tiny?.href
        || image?.meta?.downloadHref
        || null;

      return url;
    } catch (error) {
      console.error(`Error getting image for product ${productId}:`, error.message);
      return null;
    }
  }

  // Скачивание изображения по URL (для прокси)
  async downloadImage(imageUrl) {
    if (!imageUrl) return null;

    try {
      const response = await this.client.get(imageUrl, {
        responseType: 'arraybuffer',
        // Убираем baseURL для абсолютных URL
        baseURL: imageUrl.startsWith('http') ? '' : undefined
      });

      return {
        data: response.data,
        contentType: response.headers?.['content-type'] || 'image/jpeg'
      };
    } catch (error) {
      console.error('Error downloading image:', error.message);
      return null;
    }
  }

  /**
   * Получение полной информации о товаре включая доп. поля
   */
  async getProductFullInfo(productId) {
    try {
      // Получаем товар из БД для meta_href
      const { getDb } = await import('../database.js');
      const db = await getDb();
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      
      if (!product || !product.meta_href) {
        return { product, attributes: {} };
      }
      
      // Запрашиваем товар из МойСклад с expand на attributes
      const url = product.meta_href.replace(BASE_URL, '');
      const response = await this.client.get(url);
      const msProduct = response.data;
      
      // Парсим доп. поля (attributes)
      const attributes = {};
      if (msProduct.attributes && Array.isArray(msProduct.attributes)) {
        for (const attr of msProduct.attributes) {
          const name = attr.name?.toLowerCase() || '';
          
          // Дата изготовления
          if (name.includes('дата изготовления') || name.includes('дата производства') || name === 'производство') {
            attributes.manufactureDate = attr.value;
          }
          // Срок годности
          if (name.includes('срок годности') || name.includes('годен до')) {
            attributes.expiryDate = attr.value;
          }
          // Размер
          if (name.includes('размер') || name === 'size') {
            attributes.size = attr.value?.name || attr.value;
          }
          // Страна
          if (name.includes('страна') || name.includes('country')) {
            attributes.country = attr.value?.name || attr.value;
          }
          // Цвет
          if (name.includes('цвет') || name === 'color') {
            attributes.color = attr.value?.name || attr.value;
          }
        }
      }
      
      // Также проверяем поле country если есть
      if (msProduct.country?.name) {
        attributes.country = msProduct.country.name;
      }
      
      return {
        product: {
          ...product,
          name: msProduct.name || product.name,
          article: msProduct.article || product.article,
          barcode: product.barcode
        },
        attributes
      };
    } catch (error) {
      console.error('Error getting product full info:', error.message);
      // Возвращаем базовую информацию из БД
      const { getDb } = await import('../database.js');
      const db = await getDb();
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
      return { product, attributes: {} };
    }
  }

  /**
   * Получение списка организаций
   */
  async getOrganizations() {
    try {
      const res = await this.client.get('/entity/organization', { params: { limit: 100 } });
      return (res.data?.rows || []).map(org => ({
        id: org.id,
        name: org.name,
        meta: org.meta
      }));
    } catch (error) {
      console.error('Error getting organizations:', error.message);
      return [];
    }
  }

  /**
   * Получение списка складов
   */
  async getStores() {
    try {
      const res = await this.client.get('/entity/store', { params: { limit: 100 } });
      return (res.data?.rows || []).map(store => ({
        id: store.id,
        name: store.name,
        meta: store.meta
      }));
    } catch (error) {
      console.error('Error getting stores:', error.message);
      return [];
    }
  }

  /**
   * Получение списка контрагентов
   */
  async getCounterparties(search = '') {
    try {
      const params = { limit: 100 };
      if (search) {
        params.search = search;
      }
      const res = await this.client.get('/entity/counterparty', { params });
      return (res.data?.rows || []).map(cp => ({
        id: cp.id,
        name: cp.name,
        meta: cp.meta
      }));
    } catch (error) {
      console.error('Error getting counterparties:', error.message);
      return [];
    }
  }

  /**
   * Создание документа "Заказ покупателя" в МойСклад
   * @param {Object} params - Параметры
   * @param {string} params.name - Название заказа
   * @param {Array} params.items - Товары [{quantity, meta_href}]
   * @param {string} params.organizationId - ID организации
   * @param {string} params.counterpartyId - ID контрагента
   * @param {string} params.storeId - ID склада
   */
  async createCustomerOrder({ name, items, organizationId, counterpartyId, storeId }) {
    try {
      // Формируем позиции заказа
      const positions = [];
      for (const item of items) {
        if (!item.meta_href || item.quantity <= 0) continue;
        
        positions.push({
          quantity: item.quantity,
          price: item.price || 0,
          assortment: {
            meta: {
              href: item.meta_href,
              type: 'product',
              mediaType: 'application/json'
            }
          }
        });
      }

      if (positions.length === 0) {
        throw new Error('Нет позиций для заказа');
      }

      const orderData = {
        name: name,
        organization: {
          meta: {
            href: `${BASE_URL}/entity/organization/${organizationId}`,
            type: 'organization',
            mediaType: 'application/json'
          }
        },
        agent: {
          meta: {
            href: `${BASE_URL}/entity/counterparty/${counterpartyId}`,
            type: 'counterparty',
            mediaType: 'application/json'
          }
        },
        store: {
          meta: {
            href: `${BASE_URL}/entity/store/${storeId}`,
            type: 'store',
            mediaType: 'application/json'
          }
        },
        positions: positions
      };

      const order = await this.client.post('/entity/customerorder', orderData);
      console.log(`Создан заказ покупателя: ${order.data.name}, ID: ${order.data.id}`);
      return order.data;

    } catch (error) {
      console.error('Error creating customer order:', error.response?.data || error.message);
      throw new Error(`Ошибка создания заказа: ${error.response?.data?.errors?.[0]?.error || error.message}`);
    }
  }

  /**
   * Создание документа "Отгрузка" на основании "Заказа покупателя"
   * @param {Object} params - Параметры
   * @param {string} params.name - Название отгрузки
   * @param {Array} params.items - Товары [{quantity, meta_href, cell_address}]
   * @param {string} params.organizationId - ID организации
   * @param {string} params.counterpartyId - ID контрагента
   * @param {string} params.storeId - ID склада
   * @param {string} [params.customerOrderId] - ID заказа покупателя (для связи)
   * @param {boolean} [params.applicable=true] - Проведён ли документ (false = непроведён, остатки не списываются)
   */
  async createDemand({ name, items, organizationId, counterpartyId, storeId, customerOrderId, applicable = true }) {
    try {
      // Формируем позиции отгрузки с информацией о ячейках
      const positions = [];
      for (const item of items) {
        if (!item.meta_href || item.quantity <= 0) continue;
        
        const position = {
          quantity: item.quantity,
          price: item.price || 0,
          assortment: {
            meta: {
              href: item.meta_href,
              type: 'product',
              mediaType: 'application/json'
            }
          }
        };
        
        // Добавляем ячейку хранения если указана
        if (item.slot_href) {
          position.slot = {
            meta: {
              href: item.slot_href,
              type: 'slot',
              mediaType: 'application/json'
            }
          };
        }
        
        positions.push(position);
      }

      if (positions.length === 0) {
        throw new Error('Нет позиций для отгрузки');
      }

      const demandData = {
        name: name,
        applicable: applicable, // false = не проведён, true = проведён
        organization: {
          meta: {
            href: `${BASE_URL}/entity/organization/${organizationId}`,
            type: 'organization',
            mediaType: 'application/json'
          }
        },
        agent: {
          meta: {
            href: `${BASE_URL}/entity/counterparty/${counterpartyId}`,
            type: 'counterparty',
            mediaType: 'application/json'
          }
        },
        store: {
          meta: {
            href: `${BASE_URL}/entity/store/${storeId}`,
            type: 'store',
            mediaType: 'application/json'
          }
        },
        positions: positions
      };

      // Связываем с заказом покупателя если есть
      if (customerOrderId) {
        demandData.customerOrder = {
          meta: {
            href: `${BASE_URL}/entity/customerorder/${customerOrderId}`,
            type: 'customerorder',
            mediaType: 'application/json'
          }
        };
      }

      const demand = await this.client.post('/entity/demand', demandData);
      console.log(`Создана отгрузка: ${demand.data.name}, ID: ${demand.data.id}, Проведена: ${applicable}`);
      return demand.data;

    } catch (error) {
      console.error('Error creating demand:', error.response?.data || error.message);
      throw new Error(`Ошибка создания отгрузки: ${error.response?.data?.errors?.[0]?.error || error.message}`);
    }
  }

  /**
   * Проведение документа Отгрузка (списание остатков)
   * @param {string} demandId - ID отгрузки
   */
  async approveDemand(demandId) {
    try {
      const demand = await this.client.put(`/entity/demand/${demandId}`, {
        applicable: true
      });
      console.log(`Отгрузка проведена: ${demand.data.name}, ID: ${demandId}`);
      return demand.data;
    } catch (error) {
      console.error('Error approving demand:', error.response?.data || error.message);
      throw new Error(`Ошибка проведения отгрузки: ${error.response?.data?.errors?.[0]?.error || error.message}`);
    }
  }

  /**
   * Кэш ячеек для ускорения поиска
   */
  _slotCache = new Map();
  _slotCacheLoaded = false;

  /**
   * Нормализует название ячейки для сравнения
   * "Стеллаж 1, полка 1, ячейка A" -> "стеллаж1полка1ячейкаa"
   */
  _normalizeSlotName(name) {
    if (!name) return '';
    return name
      .toLowerCase()
      .replace(/[,.\s]+/g, '') // убираем запятые, точки, пробелы
      .replace(/стелаж/g, 'стеллаж'); // исправляем опечатку
  }

  /**
   * Загрузка всех ячеек склада в кэш через рабочий API
   */
  async loadSlotsCache() {
    if (this._slotCacheLoaded) return;
    
    try {
      const storeId = await this.storeId();
      if (!storeId) {
        console.log('[loadSlotsCache] Склад не настроен');
        return;
      }
      
      console.log(`[loadSlotsCache] Загружаем ячейки для склада ${storeId}...`);
      
      // Используем рабочий метод getAllStoreSlots
      const slots = await this.getAllStoreSlots(storeId);
      console.log(`[loadSlotsCache] Получено ${slots.length} ячеек`);
      
      for (const slot of slots) {
        const name = slot.name || '';
        const normalizedKey = this._normalizeSlotName(name);
        
        const slotData = {
          id: slot.id,
          name: slot.name,
          href: slot.meta?.href,
          barcode: slot.barcode || ''
        };
        
        // Сохраняем по нормализованному имени
        if (normalizedKey) {
          this._slotCache.set(normalizedKey, slotData);
        }
        
        // Также сохраняем по штрихкоду если есть
        if (slot.barcode) {
          this._slotCache.set(`barcode:${slot.barcode}`, slotData);
        }
      }
      
      this._slotCacheLoaded = true;
      console.log(`[loadSlotsCache] Загружено ${this._slotCache.size} записей в кэш`);
      
      // Показываем первые 3 для отладки
      let count = 0;
      for (const [key, value] of this._slotCache) {
        if (count++ < 3 && !key.startsWith('barcode:')) {
          console.log(`[loadSlotsCache]   "${value.name}" -> key: "${key}"`);
        }
      }
      
    } catch (error) {
      console.error('[loadSlotsCache] Ошибка:', error.message);
      this._slotCacheLoaded = true; // Помечаем как загруженный чтобы не повторять
    }
  }

  /**
   * Получение ячейки хранения по названию
   * @param {string} slotName - Название ячейки (например "Стеллаж 1 полка 1 ячейка A")
   * @returns {Object|null} - {id, name, href} или null
   */
  async getSlotByName(slotName) {
    if (!slotName) return null;
    
    // Загружаем кэш если ещё не загружен
    await this.loadSlotsCache();
    
    // Сначала проверяем - может это штрихкод
    const barcodeKey = `barcode:${slotName}`;
    if (this._slotCache.has(barcodeKey)) {
      const found = this._slotCache.get(barcodeKey);
      console.log(`[getSlotByName] Найдено по штрихкоду: "${found.name}"`);
      return found;
    }
    
    const normalizedSearch = this._normalizeSlotName(slotName);
    
    // Поиск по нормализованному ключу (точное совпадение)
    if (this._slotCache.has(normalizedSearch)) {
      const found = this._slotCache.get(normalizedSearch);
      console.log(`[getSlotByName] Найдено точное: "${slotName}" -> "${found.name}" (${found.id})`);
      return found;
    }
    
    // Если не нашли точное совпадение, ищем по частичному
    for (const [key, value] of this._slotCache) {
      if (key.startsWith('barcode:')) continue;
      
      if (key.includes(normalizedSearch) || normalizedSearch.includes(key)) {
        console.log(`[getSlotByName] Найдено частичное: "${slotName}" -> "${value.name}" (${value.id})`);
        return value;
      }
    }
    
    console.log(`[getSlotByName] НЕ найдено: "${slotName}" (normalized: "${normalizedSearch}")`);
    return null;
  }
}

let instance = null;

export function getMoySkladService() {
  if (!instance) {
    instance = new MoySkladService();
  }
  return instance;
}

export default MoySkladService;
