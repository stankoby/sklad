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

    // Базовые товары (нужны изображения и миниатюры для превью)
    await fetchAll('/entity/product', { expand: 'images,images.miniature' });

    // Модификации (variants)
    await fetchAll('/entity/variant', { expand: 'images,images.miniature,product,product.images,product.images.miniature' });

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
    const ids = (assortmentIds || []).map(String).filter(Boolean);
    if (!ids.length) return [];

    // Определяем склад
    let sid = storeId ? String(storeId).trim() : '';
    if (!sid) {
      const storeName = (process.env.MOYSKLAD_STORE_NAME || 'Склад хранения.').trim();
      const storeHref = await this.findStoreHref(storeName);
      if (storeHref) {
        sid = String(storeHref).split('/').pop();
      }
    }
    if (!sid) {
      throw new Error('Не удалось определить storeId. Укажите MOYSKLAD_STORE_NAME или MOYSKLAD_STORE_ID');
    }

    // В МойСклад есть лимиты по длине URL и rate limit.
    // Бьём список товаров на чанки.
    const chunkSize = Number(process.env.MOYSKLAD_SLOT_CHUNK_SIZE || 100);
    const chunks = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      chunks.push(ids.slice(i, i + chunkSize));
    }

    const allRows = [];
    for (const chunk of chunks) {
      const filter = `assortmentId=${chunk.join(',')};storeId=${sid}`;
      const resp = await this.client.get('/report/stock/byslot/current', {
        params: { filter }
      });
      const rows = resp.data?.rows || [];
      allRows.push(...rows);
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
}

let instance = null;

export function getMoySkladService() {
  if (!instance) {
    instance = new MoySkladService();
  }
  return instance;
}

export default MoySkladService;
