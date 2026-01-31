import axios from 'axios';

const api = axios.create({ baseURL: '/api', timeout: 30000 });

// Products
export const getProducts = (params) => api.get('/products', { params });
export const syncProducts = () => api.post('/products/sync');
export const getSyncStatus = () => api.get('/products/sync/status');

// Upload "Остатки по ячейкам" XLS report from MoySklad
export const uploadLocationsXls = (file) => {
  const formData = new FormData();
  formData.append('file', file);
  return api.post('/products/locations/upload', formData);
};

// Packing
export const getPackingTasks = () => api.get('/packing/tasks');
export const getPackingTask = (id) => api.get(`/packing/tasks/${id}`);

export const uploadPackingExcel = (file) => {
  const formData = new FormData();
  formData.append('file', file);
  return api.post('/packing/tasks/upload', formData);
};

// Scan supports optional: chestnyZnak, boxId
export const scanPackingItem = (taskId, barcode, { chestnyZnak, boxId } = {}) =>
  api.post(`/packing/tasks/${taskId}/scan`, { barcode, chestnyZnak, boxId });

export const getPackingBoxes = (taskId) => api.get(`/packing/tasks/${taskId}/boxes`);
export const createPackingBox = (taskId) => api.post(`/packing/tasks/${taskId}/boxes`);
export const closePackingBox = (taskId, boxId) => api.post(`/packing/tasks/${taskId}/boxes/${boxId}/close`);

export const completePacking = (taskId) => api.post(`/packing/tasks/${taskId}/complete`);

// Receiving
export const getReceivingSessions = () => api.get('/receiving/sessions');
export const getReceivingSession = (id) => api.get(`/receiving/sessions/${id}`);
export const createReceivingSession = (name) => api.post('/receiving/sessions', { name });
export const addReceivingItem = (sessionId, productId, quantity) =>
  api.post(`/receiving/sessions/${sessionId}/items`, { productId, quantity });
export const removeReceivingItem = (sessionId, itemId) =>
  api.delete(`/receiving/sessions/${sessionId}/items/${itemId}`);
export const completeReceiving = (sessionId) => api.post(`/receiving/sessions/${sessionId}/complete`);

export default api;
