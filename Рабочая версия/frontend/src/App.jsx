import { useState, useEffect, useRef } from 'react';
import { useSync } from './hooks/useSync';
import api, { getProducts, uploadLocationsXls } from './api';
import { Package, PackageCheck, Truck, RefreshCw, Search, Upload, Plus, ArrowLeft, CheckCircle, Box, Scan, Minus, AlertTriangle } from 'lucide-react';

function BarcodeSVG({ value, height = 40 }) {
  if (!value) return null;
  const patterns = {'0':'11011001100','1':'11001101100','2':'11001100110','3':'10010011000','4':'10010001100','5':'10001001100','6':'10011001000','7':'10011000100','8':'10001100100','9':'11001001000','A':'11001000100','B':'11000100100','C':'10110011100','D':'10011011100','E':'10011001110','F':'10111001100','G':'10011101100','H':'10011100110','I':'11001110010','J':'11001011100','K':'11001001110','L':'11011100100','M':'11001110100','N':'11101101110','O':'11101001100','P':'11100101100','Q':'11100100110','R':'11101100100','S':'11100110100','T':'11100110010','U':'11011011000','V':'11011000110','W':'11000110110','X':'10100011000','Y':'10001011000','Z':'10001000110','_':'10110001000',' ':'11011000010','-':'10001101000'};
  let binary = '11010000100';
  for (let c of String(value).toUpperCase()) binary += patterns[c] || patterns['0'];
  binary += '1100011101011';
  const w = 1.5;
  return <svg width={binary.length*w} height={height} viewBox={`0 0 ${binary.length*w} ${height}`}>{binary.split('').map((b,i)=>b==='1'&&<rect key={i} x={i*w} y={0} width={w} height={height} fill="black"/>)}</svg>;
}

function Toast({ message, type, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  return <div className={`fixed bottom-4 right-4 ${type==='success'?'bg-emerald-500':type==='error'?'bg-red-500':'bg-blue-500'} text-white px-4 py-3 rounded-xl shadow-lg z-50`}>{message}</div>;
}

function Header({ page, setPage, sync }) {
  const { status, syncing } = sync;
  return (
    <header className="bg-white border-b sticky top-0 z-40">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center"><Package className="w-4 h-4 text-white" /></div>
          <nav className="flex gap-1">
            {[['products','Товары',Package],['packing','Упаковка',PackageCheck],['receiving','Приемка',Truck]].map(([id,label,Icon])=>(
              <button key={id} onClick={()=>setPage(id)} className={`flex items-center gap-2 px-3 py-2 rounded-lg ${page===id?'bg-blue-50 text-blue-700':'text-gray-600 hover:bg-gray-50'}`}>
                <Icon className="w-4 h-4"/><span className="hidden sm:block">{label}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2 py-1 rounded-full ${status?.connected?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-700'}`}>{status?.connected?'МойСклад ✓':'Нет связи'}</span>
          <button onClick={sync.sync} disabled={syncing} className="btn-secondary flex items-center gap-2 text-sm py-2">
            <RefreshCw className={`w-4 h-4 ${syncing?'animate-spin':''}`}/><span className="hidden sm:block">{syncing?'Синхр...':'Синхронизировать'}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

function ProductsPage({ showToast }) {
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const locFileRef = useRef();
  const [locUploading, setLocUploading] = useState(false);

  const onUploadLocations = async (file) => {
    if (!file) return;
    try {
      setLocUploading(true);
      const { data } = await uploadLocationsXls(file);
      showToast(`Ячейки обновлены: ${data?.updated ?? 0}`, 'success');
      // Перезагружаем список, чтобы сразу увидеть cell_address в выдаче (если включите в карточке)
      const r = await getProducts({ search, limit: 50 });
      setProducts(r.data.products);
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || 'Ошибка загрузки отчёта';
      showToast(msg, 'error');
    } finally {
      setLocUploading(false);
      if (locFileRef.current) locFileRef.current.value = '';
    }
  };
  useEffect(() => { setLoading(true); getProducts({ search, limit: 50 }).then(({data})=>setProducts(data.products)).finally(()=>setLoading(false)); }, [search]);
  return (
    <div className="max-w-6xl mx-auto px-4 py-4">
      <div className="card mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1">
          <div className="font-medium">Адреса ячеек (для маршрутного листа)</div>
          <div className="text-sm text-gray-600">Экспортируйте в МойСклад: Склад → Остатки → Остатки по ячейкам → XLS. Затем загрузите сюда.</div>
        </div>
        <input ref={locFileRef} type="file" accept=".xls,.xlsx" className="hidden" onChange={(e)=>onUploadLocations(e.target.files?.[0])} />
        <button className="btn-secondary flex items-center gap-2" onClick={()=>locFileRef.current?.click()} disabled={locUploading}>
          <Upload className="w-4 h-4" /> {locUploading?'Загрузка...':'Загрузить XLS'}
        </button>
      </div>
      <div className="relative mb-4"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"/><input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Поиск товаров..." className="input pl-10"/></div>
      <div className="grid gap-3">
        {loading?<div className="text-center py-8 text-gray-500">Загрузка...</div>:products.length===0?<div className="text-center py-8 text-gray-500">Товары не найдены</div>:products.map(p=>(
          <div key={p.id} className="card flex items-center gap-4">
            <div className="w-16 h-16 bg-gray-100 rounded-xl flex items-center justify-center"><Package className="w-6 h-6 text-gray-400"/></div>
            <div className="flex-1"><h3 className="font-medium">{p.name}</h3><p className="text-sm text-gray-500">{p.barcode||'Нет штрихкода'} • {p.article||'—'}</p></div>
            <div className="text-right"><p className="font-bold">{p.stock||0} шт</p><p className="text-sm text-gray-500">{p.price?`${p.price} ₽`:'—'}</p></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Sound effects helper
const playSound=(type)=>{try{const ctx=new(window.AudioContext||window.webkitAudioContext)();const osc=ctx.createOscillator();const gain=ctx.createGain();osc.connect(gain);gain.connect(ctx.destination);if(type==='success'){osc.frequency.setValueAtTime(880,ctx.currentTime);osc.frequency.setValueAtTime(1100,ctx.currentTime+0.1);gain.gain.setValueAtTime(0.3,ctx.currentTime);osc.start(ctx.currentTime);osc.stop(ctx.currentTime+0.2);}else if(type==='warning'){osc.frequency.setValueAtTime(440,ctx.currentTime);osc.frequency.setValueAtTime(330,ctx.currentTime+0.15);gain.gain.setValueAtTime(0.4,ctx.currentTime);osc.start(ctx.currentTime);osc.stop(ctx.currentTime+0.3);}else if(type==='error'){osc.frequency.setValueAtTime(200,ctx.currentTime);osc.type='square';gain.gain.setValueAtTime(0.3,ctx.currentTime);osc.start(ctx.currentTime);osc.stop(ctx.currentTime+0.4);}else if(type==='complete'){osc.frequency.setValueAtTime(523,ctx.currentTime);osc.frequency.setValueAtTime(659,ctx.currentTime+0.1);osc.frequency.setValueAtTime(784,ctx.currentTime+0.2);gain.gain.setValueAtTime(0.3,ctx.currentTime);osc.start(ctx.currentTime);osc.stop(ctx.currentTime+0.35);}}catch(e){}};
const getProxiedImageUrl=(url)=>url?`/api/image-proxy?url=${encodeURIComponent(url)}`:null;
const getProductImageUrl=(productId)=>productId?`/api/products/${productId}/image`:null;

function PackingPage({ showToast }) {
  const [tasks, setTasks] = useState([]);
  const [activeTask, setActiveTask] = useState(null);
  const [taskItems, setTaskItems] = useState([]);
  const [showUpload, setShowUpload] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [showRouteSheet, setShowRouteSheet] = useState(false);
  const [routeSheet, setRouteSheet] = useState(null);
  const [boxes, setBoxes] = useState([]);
  const [activeBoxId, setActiveBoxId] = useState(null);
  const [markingModal, setMarkingModal] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState(1);
  const [manualItems, setManualItems] = useState([]);
  const scanRef = useRef();
  const markingRef = useRef();
  const fileRef = useRef();

  const loadTasks = async () => { try { const {data} = await api.get('/packing/tasks'); setTasks(data); } catch(err) { showToast('Ошибка','error'); }};

  const loadBoxes = async (taskId) => {
    try {
      const { data } = await api.get(`/packing/tasks/${taskId}/boxes`);
      const b = data.boxes || [];
      setBoxes(b);
      // Выбор активного короба: открытый последний, иначе первый
      if (!activeBoxId) {
        const open = b.filter(x => x.status === 'open');
        const pick = (open.length ? open[open.length-1] : b[b.length-1]);
        setActiveBoxId(pick ? pick.id : null);
      } else {
        // если активный короб удален/пропал — выбрать другой
        if (!b.some(x => String(x.id) === String(activeBoxId))) {
          const open = b.filter(x => x.status === 'open');
          const pick = (open.length ? open[open.length-1] : b[b.length-1]);
          setActiveBoxId(pick ? pick.id : null);
        }
      }
    } catch (err) {
      // ignore
    }
  };

  const ensureBox = async (taskId) => {
    try {
      const { data } = await api.post(`/packing/tasks/${taskId}/boxes`);
      const newId = data?.box?.id;
      await loadBoxes(taskId);
      if (newId) setActiveBoxId(newId);
      return newId;
    } catch (e) {
      return null;
    }
  };

  const loadTask = async (id) => {
    try {
      const {data} = await api.get(`/packing/tasks/${id}`);
      setActiveTask(data.task);
      setTaskItems(data.items);
      await loadBoxes(id);
      // Если коробов нет — создаем первый автоматически
      const hasBoxes = (data && boxes && boxes.length > 0);
      // can't rely on state immediately; check on server
      const bx = await api.get(`/packing/tasks/${id}/boxes`).then(r=>r.data.boxes||[]).catch(()=>[]);
      setBoxes(bx);
      if (bx.length === 0) {
        const nid = await ensureBox(id);
        if (nid) setActiveBoxId(nid);
      } else {
        const open = bx.filter(x=>x.status==='open');
        const pick = (open.length ? open[open.length-1] : bx[bx.length-1]);
        setActiveBoxId(pick ? pick.id : null);
      }
    } catch(err) {
      showToast('Ошибка','error');
    }
  };
  
  useEffect(() => { loadTasks(); }, []);
  useEffect(() => { if (activeTask && scanRef.current) scanRef.current.focus(); }, [activeTask, taskItems]);
  useEffect(() => { if (showManual) getProducts({search,limit:50}).then(({data})=>setProducts(data.products)); }, [showManual, search]);

  useEffect(() => {
    if (markingModal) {
      setTimeout(() => markingRef.current?.focus(), 50);
    }
  }, [markingModal]);

  const openImagePreview = (src, name) => {
    if (!src) return;
    setImagePreview({ src, name });
  };

  const closeImagePreview = () => {
    setImagePreview(null);
    if (activeTask?.status === 'active') {
      setTimeout(() => scanRef.current?.focus(), 50);
    }
  };

  

  const handleScan = async (barcode) => {
    if (!barcode.trim() || !activeTask) return;
    const cleaned = barcode.trim();

    // Ensure we have an active box
    let boxId = activeBoxId;
    if (!boxId) {
      boxId = await ensureBox(activeTask.id);
      if (!boxId) {
        playSound('error');
        showToast('Не удалось создать короб','error');
        return;
      }
    }

    // Если товар маркируемый — сначала попросим код маркировки
    const item = taskItems.find(i => String(i.barcode || '').trim() === cleaned);
    if (item && Number(item.requires_marking) === 1) {
      setMarkingModal({ barcode: cleaned, product: item.name, boxId });
      // фокус на поле маркировки появится в useEffect ниже
      return;
    }

    try {
      const { data } = await api.post(`/packing/tasks/${activeTask.id}/scan`, { barcode: cleaned, boxId });
      playSound(data.complete ? 'success' : 'warning');
      showToast(`${data.product}: ${data.scanned}/${data.quantity}`, data.complete ? 'success' : 'info');
      await loadTask(activeTask.id);
      await loadBoxes(activeTask.id);
    } catch (err) {
      playSound('error');
      showToast(err.response?.data?.error || 'Ошибка','error');
    }
  };

  const submitMarking = async (markingCode) => {
    if (!markingModal || !activeTask) return;
    const code = String(markingCode || '').trim();
    if (!code) {
      playSound('error');
      showToast('Сканируйте/введите код маркировки','error');
      return;
    }
    try {
      const { data } = await api.post(`/packing/tasks/${activeTask.id}/scan`, {
        barcode: markingModal.barcode,
        boxId: markingModal.boxId,
        chestnyZnak: code,
      });
      playSound(data.complete ? 'success' : 'warning');
      showToast(`${data.product}: ${data.scanned}/${data.quantity}`, data.complete ? 'success' : 'info');
      setMarkingModal(null);
      await loadTask(activeTask.id);
      await loadBoxes(activeTask.id);
      setTimeout(() => scanRef.current?.focus(), 50);
    } catch (err) {
      playSound('error');
      showToast(err.response?.data?.error || 'Ошибка','error');
    }
  };

  const handleUpload = async (e) => { 
    const file = e.target.files?.[0]; 
    if (!file) return; 
    const fd = new FormData(); 
    fd.append('file',file); 
    try { 
      const {data} = await api.post('/packing/tasks/upload',fd); 
      showToast(`Создано ${data.created} позиций`,'success'); 
      setShowUpload(false); 
      loadTasks();
      if (data.taskId) loadTask(data.taskId);
    } catch(err) { 
      showToast(err.response?.data?.error||'Ошибка загрузки','error'); 
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleAddManualItem = () => {
    if (!selected) return;
    const existing = manualItems.find(i => i.product.id === selected.id);
    if (existing) {
      setManualItems(manualItems.map(i => i.product.id === selected.id ? {...i, quantity: i.quantity + qty} : i));
    } else {
      setManualItems([...manualItems, { product: selected, quantity: qty }]);
    }
    setSelected(null);
    setQty(1);
  };

  const handleCreateManualTask = async () => {
    if (manualItems.length === 0) return;
    try {
      const {data} = await api.post('/packing/tasks', { 
        items: manualItems.map(i => ({ productId: i.product.id, quantity: i.quantity }))
      });
      showToast(`Создана задача: ${data.itemsCount} позиций`,'success');
      setShowManual(false);
      setManualItems([]);
      loadTasks();
      if (data.taskId) loadTask(data.taskId);
    } catch(err) {
      showToast('Ошибка создания','error');
    }
  };

  const handleComplete = async () => {
    if (!activeTask) return;
    try {
      const {data} = await api.post(`/packing/tasks/${activeTask.id}/complete`);
      playSound('complete');
      showToast(data.message,'success');
      setActiveTask(null);
      loadTasks();
    } catch(err) {
      showToast(err.response?.data?.error||'Ошибка','error');
    }
  };

  const handleNewBox = async () => {
    if (!activeTask) return;
    try {
      const { data } = await api.post(`/packing/tasks/${activeTask.id}/boxes`);
      const newId = data?.box?.id;
      await loadBoxes(activeTask.id);
      if (newId) setActiveBoxId(newId);
      playSound('warning');
      showToast(`Создан короб #${data?.box?.number || ''}`,'success');
      setTimeout(() => scanRef.current?.focus(), 50);
    } catch (err) {
      playSound('error');
      showToast(err.response?.data?.error || 'Ошибка создания короба','error');
    }
  };

  const handleCloseBox = async () => {
    if (!activeTask || !activeBoxId) return;
    try {
      await api.post(`/packing/tasks/${activeTask.id}/boxes/${activeBoxId}/close`);
      playSound('success');
      showToast('Короб закрыт','success');
      await loadBoxes(activeTask.id);
      // Автоматически создаём новый короб для продолжения
      const { data } = await api.post(`/packing/tasks/${activeTask.id}/boxes`);
      const newId = data?.box?.id;
      await loadBoxes(activeTask.id);
      if (newId) setActiveBoxId(newId);
      setTimeout(() => scanRef.current?.focus(), 50);
    } catch (err) {
      playSound('error');
      const msg = err.response?.data?.error || 'Ошибка закрытия короба';
      showToast(msg,'error');
    }
  };

  const loadRouteSheet = async () => {
    try {
      const {data} = await api.get(`/packing/tasks/${activeTask.id}/route-sheet`);
      setRouteSheet(data);
      setShowRouteSheet(true);
    } catch(err) {
      showToast('Ошибка загрузки','error');
    }
  };

  if (activeTask) {
    const total = taskItems.reduce((s,i)=>s+(i.planned_qty||0),0);
    const scanned = taskItems.reduce((s,i)=>s+(i.scanned_qty||0),0);
    const progress = total>0?(scanned/total)*100:0;
    
    return (
      <div className="max-w-5xl mx-auto px-4 py-4">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <button onClick={()=>{setActiveTask(null);setTaskItems([]);}} className="btn-secondary p-2"><ArrowLeft className="w-5 h-5"/></button>
          <div className="flex-1 min-w-[200px]">
            <h2 className="font-bold text-lg">{activeTask.name}</h2>
            <p className="text-sm text-gray-500">Собрано: {scanned} / {total}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={loadRouteSheet} className="btn-secondary flex items-center gap-2 text-sm">
              <Package className="w-4 h-4"/> Маршрутный лист
            </button>
            {activeTask.status==='active' && scanned > 0 && (
              <button onClick={handleComplete} className="bg-emerald-500 text-white px-4 py-2 rounded-xl font-medium flex items-center gap-2">
                <CheckCircle className="w-4 h-4"/> Завершить
              </button>
            )}
          </div>
        </div>
        
        <div className="card mb-4">
          <div className="flex justify-between text-sm mb-2"><span>Прогресс</span><span className="font-bold">{Math.round(progress)}%</span></div>
          <div className="h-3 bg-gray-100 rounded-full overflow-hidden"><div className={`h-full transition-all ${progress>=100?'bg-emerald-500':'bg-blue-500'}`} style={{width:`${progress}%`}}/></div>
        
</div>

        <div className="card mb-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Box className="w-5 h-5 text-blue-600"/>
              <span className="font-semibold">Короба</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleNewBox} className="btn-secondary flex items-center gap-2 text-sm"><Plus className="w-4 h-4"/> Новый короб</button>
              <button onClick={handleCloseBox} disabled={!activeBoxId} className={`flex items-center gap-2 text-sm px-4 py-2 rounded-xl font-medium ${activeBoxId?'bg-amber-500 text-white hover:bg-amber-600':'bg-gray-100 text-gray-400 cursor-not-allowed'}`}><Box className="w-4 h-4"/> Закрыть короб</button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {boxes.length===0 ? (
              <span className="text-sm text-gray-500">Короба не созданы</span>
            ) : boxes.map(b => (
              <button key={b.id} onClick={() => setActiveBoxId(b.id)} className={`px-3 py-2 rounded-xl border text-sm font-medium flex items-center gap-2 ${String(activeBoxId)===String(b.id)?'bg-blue-50 border-blue-300 text-blue-800':'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'}`}>
                <span>#{b.number}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${b.status==='closed'?'bg-emerald-100 text-emerald-700':'bg-blue-100 text-blue-700'}`}>{b.status==='closed'?'закрыт':'открыт'}</span>
              </button>
            ))}
          </div>

          {activeBoxId && (
            <p className="mt-3 text-sm text-gray-500">Активный короб: <strong>#{(boxes.find(b=>String(b.id)===String(activeBoxId))?.number)||'—'}</strong></p>
          )}
        </div>

        {activeTask.status==='active'&&(

          <div className="card mb-4 bg-gradient-to-r from-blue-500 to-blue-600 text-white">
            <div className="flex items-center gap-2 mb-3"><Scan className="w-5 h-5"/><span className="font-medium">Сканирование</span></div>
            <input ref={scanRef} type="text" placeholder="Отсканируйте штрихкод..." className="w-full px-4 py-3 rounded-xl text-xl font-mono text-gray-900 bg-white" autoFocus onKeyDown={e=>{if(e.key==='Enter'&&e.target.value){handleScan(e.target.value);e.target.value='';}}}/>
          </div>
        )}
        
        <div className="space-y-2">
          {taskItems.map(item=>{
            const complete = (item.scanned_qty||0) >= (item.planned_qty||0);
            const hasStock = (item.stock||0) > 0;
            const imageSrc = getProductImageUrl(item.product_id) || getProxiedImageUrl(item.image_url);
            return (
              <div key={item.id} className={`card flex items-center gap-4 ${complete?'bg-emerald-50':!hasStock?'bg-red-50':''}`}>
                <div className="w-14 h-14 bg-gray-100 rounded-lg flex items-center justify-center overflow-hidden relative">
                  <Package className="w-6 h-6 text-gray-400"/>
                  {imageSrc && (
                    <img
                      src={imageSrc}
                      alt={item.name}
                      className="absolute inset-0 w-full h-full object-cover cursor-zoom-in"
                      onClick={() => openImagePreview(imageSrc, item.name)}
                      onError={(e)=>{e.currentTarget.style.display='none';}}
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{item.name}</p>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {item.barcode && <span className="text-xs bg-gray-100 px-2 py-0.5 rounded font-mono">{item.barcode}</span>}
                    {item.cell_address && <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">📍 {item.cell_address}</span>}
                    <span className={`text-xs px-2 py-0.5 rounded ${hasStock?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-700'}`}>Остаток: {item.stock||0}</span>
                  </div>
                </div>
                <div className="text-right">
                  <p className={`font-bold text-xl ${complete?'text-emerald-600':''}`}>{item.scanned_qty||0} / {item.planned_qty||0}</p>
                  {complete && <CheckCircle className="w-5 h-5 text-emerald-500 ml-auto"/>}
                </div>
              </div>
            );
          })}
        </div>

        {/* Route Sheet Modal */}
        {showRouteSheet && routeSheet && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setShowRouteSheet(false)}>
            <div className="bg-white rounded-2xl p-5 max-w-2xl w-full max-h-[90vh] overflow-auto" onClick={e=>e.stopPropagation()}>
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h2 className="text-xl font-bold">Маршрутный лист</h2>
                  <p className="text-sm text-gray-500">{routeSheet.task.name}</p>
                </div>
                <button onClick={()=>window.print()} className="btn-secondary text-sm">🖨️ Печать</button>
              </div>
              
              {routeSheet.noStockCount > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-4">
                  <p className="text-red-700 font-medium">⚠️ Нет на складе: {routeSheet.noStockCount} позиций</p>
                  <div className="mt-2 space-y-1">
                    {routeSheet.noStock.map(i => <p key={i.id} className="text-sm text-red-600">{i.name} — {i.planned_qty} шт</p>)}
                  </div>
                </div>
              )}
              
              <p className="text-sm text-gray-500 mb-4">К сбору: <strong>{routeSheet.totalToCollect}</strong> шт из {routeSheet.available} позиций</p>

              {routeSheet.availableWithShelfCount === 0 && routeSheet.hangingStock?.length > 0 && (
                <div className="mb-4">
                  <h3 className="font-bold text-lg bg-amber-100 text-amber-800 px-3 py-2 rounded-lg mb-2">Без адреса</h3>
                  <div className="space-y-2">
                    {routeSheet.hangingStock.map(item => (
                      <div key={item.id} className="flex items-center gap-3 p-2 bg-amber-50 rounded-lg">
                        <span className="font-mono text-sm bg-white px-2 py-1 rounded border">{item.cell_address||'—'}</span>
                        <div className="flex-1">
                          <p className="font-medium text-sm">{item.name}</p>
                          <p className="text-xs text-gray-500">{item.barcode}</p>
                        </div>
                        <span className="font-bold text-lg">{item.qty_to_collect}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {Object.entries(routeSheet.zones).map(([zone, items]) => (
                <div key={zone} className="mb-4">
                  <h3 className="font-bold text-lg bg-blue-100 text-blue-800 px-3 py-2 rounded-lg mb-2">Стеллаж {zone}</h3>
                  <div className="space-y-2">
                    {items.map(item => (
                      <div key={item.id} className="flex items-center gap-3 p-2 bg-gray-50 rounded-lg">
                        <span className="font-mono text-sm bg-white px-2 py-1 rounded border">{item.cell_address||'—'}</span>
                        <div className="flex-1">
                          <p className="font-medium text-sm">{item.name}</p>
                          <p className="text-xs text-gray-500">{item.barcode}</p>
                        </div>
                        <span className="font-bold text-lg">{item.qty_to_collect}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {imagePreview && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={closeImagePreview}>
            <div className="bg-white rounded-2xl p-4 max-w-3xl w-full max-h-[90vh] overflow-auto" onClick={e=>e.stopPropagation()}>
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h3 className="font-semibold">{imagePreview.name || 'Фото товара'}</h3>
                  <p className="text-xs text-gray-500">Нажмите вне окна, чтобы закрыть</p>
                </div>
                <button className="btn-secondary text-sm" onClick={closeImagePreview}>Закрыть</button>
              </div>
              <img src={imagePreview.src} alt={imagePreview.name || 'Фото товара'} className="w-full h-auto rounded-xl"/>
            </div>
          </div>
        )}


        {/* Marking Modal */}
        {markingModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setMarkingModal(null)}>
            <div className="bg-white rounded-2xl p-6 max-w-md w-full" onClick={e=>e.stopPropagation()}>
              <h2 className="text-lg font-bold mb-2">Код маркировки (Честный знак)</h2>
              <p className="text-sm text-gray-600 mb-4">Товар: <strong>{markingModal.product}</strong></p>
              <input
                ref={markingRef}
                type="text"
                placeholder="Отсканируйте код маркировки..."
                className="w-full px-4 py-3 rounded-xl text-lg font-mono border-2"
                onKeyDown={e=>{ if(e.key==='Enter'){ submitMarking(e.target.value); e.target.value=''; } }}
                autoFocus
              />
              <div className="mt-4 flex justify-end gap-2">
                <button className="btn-secondary" onClick={()=>setMarkingModal(null)}>Отмена</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
  
  return (
    <div className="max-w-5xl mx-auto px-4 py-4">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-xl font-bold">Сборка / Упаковка</h1>
        <div className="flex gap-2">
          <button onClick={()=>setShowManual(true)} className="btn-secondary flex items-center gap-2"><Plus className="w-5 h-5"/> Вручную</button>
          <button onClick={()=>setShowUpload(true)} className="btn-primary flex items-center gap-2"><Upload className="w-5 h-5"/> Excel</button>
        </div>
      </div>
      
      {showUpload&&(
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setShowUpload(false)}>
          <div className="bg-white rounded-2xl p-6 max-w-md w-full" onClick={e=>e.stopPropagation()}>
            <h2 className="text-lg font-bold mb-2">Загрузка Excel</h2>
            <p className="text-sm text-gray-500 mb-4">Колонки: Barcode/Артикул + Количество</p>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleUpload} className="hidden"/>
            <button onClick={()=>fileRef.current?.click()} className="w-full btn-primary py-3">Выбрать файл</button>
          </div>
        </div>
      )}

      {showManual&&(
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>{setShowManual(false);setManualItems([]);setSelected(null);}}>
          <div className="bg-white rounded-2xl p-5 max-w-lg w-full max-h-[85vh] flex flex-col" onClick={e=>e.stopPropagation()}>
            <h2 className="text-lg font-bold mb-4">Добавить товары вручную</h2>
            
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"/>
              <input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Поиск товара..." className="w-full pl-10 pr-4 py-3 rounded-xl border-2"/>
            </div>
            
            <div className="flex-1 overflow-auto space-y-2 mb-3 min-h-[150px]">
              {products.map(p=>(
                <div key={p.id} onClick={()=>setSelected(p)} className={`p-3 rounded-xl cursor-pointer flex items-center gap-3 ${selected?.id===p.id?'bg-blue-50 border-2 border-blue-400':'bg-gray-50 border-2 border-transparent'}`}>
                  <Package className="w-10 h-10 text-gray-400"/>
                  <div className="flex-1"><p className="font-medium text-sm truncate">{p.name}</p><p className="text-xs text-gray-500">{p.barcode} • Остаток: {p.stock||0}</p></div>
                  {selected?.id===p.id&&<CheckCircle className="w-5 h-5 text-blue-500"/>}
                </div>
              ))}
            </div>
            
            {selected&&(
              <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-xl mb-3">
                <span className="flex-1 text-sm truncate">{selected.name}</span>
                <button onClick={()=>setQty(Math.max(1,qty-1))} className="w-8 h-8 rounded-lg bg-white border flex items-center justify-center"><Minus className="w-4 h-4"/></button>
                <span className="w-10 text-center font-bold">{qty}</span>
                <button onClick={()=>setQty(qty+1)} className="w-8 h-8 rounded-lg bg-white border flex items-center justify-center"><Plus className="w-4 h-4"/></button>
                <button onClick={handleAddManualItem} className="px-4 py-2 rounded-xl bg-blue-500 text-white font-medium">+</button>
              </div>
            )}
            
            {manualItems.length>0&&(
              <div className="border-t pt-3 mb-3">
                <p className="text-sm font-medium mb-2">Добавлено: {manualItems.length} поз.</p>
                <div className="space-y-1 max-h-[100px] overflow-auto">
                  {manualItems.map((item,i)=>(
                    <div key={i} className="flex justify-between text-sm bg-gray-50 px-3 py-1 rounded">
                      <span className="truncate">{item.product.name}</span>
                      <span className="font-bold">{item.quantity}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            <button onClick={handleCreateManualTask} disabled={manualItems.length===0} className={`w-full py-3 rounded-xl font-medium ${manualItems.length>0?'bg-emerald-500 text-white':'bg-gray-100 text-gray-400'}`}>
              Создать задачу ({manualItems.reduce((s,i)=>s+i.quantity,0)} шт)
            </button>
          </div>
        </div>
      )}
      
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {tasks.map(t=>{
          const progress = (t.total_items||0)>0?((t.scanned_items||0)/(t.total_items||0))*100:0;
          return (
            <div key={t.id} onClick={()=>loadTask(t.id)} className={`card cursor-pointer hover:shadow-md ${t.status==='completed'?'opacity-60':''}`}>
              <div className="flex justify-between items-start mb-2">
                <h3 className="font-semibold">{t.name}</h3>
                <span className={`text-xs px-2 py-1 rounded-full ${t.status==='completed'?'bg-emerald-100 text-emerald-700':t.status==='cancelled'?'bg-gray-100 text-gray-500':'bg-blue-100 text-blue-700'}`}>
                  {t.status==='completed'?'Готово':t.status==='cancelled'?'Отменена':'В работе'}
                </span>
              </div>
              <p className="text-sm text-gray-500 mb-2">{t.scanned_items||0} / {t.total_items||0} шт</p>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full ${t.status==='completed'?'bg-emerald-500':'bg-blue-500'}`} style={{width:`${Math.min(progress,100)}%`}}/>
              </div>
            </div>
          );
        })}
      </div>
      
      {tasks.length===0&&(
        <div className="text-center py-12 text-gray-500">
          <PackageCheck className="w-12 h-12 mx-auto mb-3 text-gray-300"/>
          <p>Нет задач на сборку</p>
          <p className="text-sm mt-2">Загрузите Excel или добавьте товары вручную</p>
        </div>
      )}
    </div>
  );
}

function ReceivingPage({ showToast }) {
  const [orders, setOrders] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [sessionData, setSessionData] = useState(null);
  const [showOrders, setShowOrders] = useState(false);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [showDefectModal, setShowDefectModal] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [showUndoConfirm, setShowUndoConfirm] = useState(false);
  const [defectQty, setDefectQty] = useState(0);
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState(1);
  const [canUndo, setCanUndo] = useState(false);
  const scanRef = useRef(null);

  const loadOrders = () => api.get('/receiving/orders').then(({data})=>setOrders(data)).catch(()=>{});
  const loadSessions = () => api.get('/receiving/sessions').then(({data})=>setSessions(data));
  const loadSession = async (id) => { try { const {data} = await api.get(`/receiving/sessions/${id}`); setSessionData(data); setActiveSession(id); setCanUndo(!!data.last_scan_item_id); } catch(err) { showToast('Ошибка','error'); }};

  useEffect(() => { loadSessions(); loadOrders(); }, []);
  useEffect(() => { if (showAddProduct) getProducts({search,limit:50}).then(({data})=>setProducts(data.products)); }, [showAddProduct, search]);
  useEffect(() => {
    if (!activeSession || sessionData?.status !== 'active') return;
    const focus = () => { if (!showAddProduct && !showDefectModal && !showUndoConfirm) scanRef.current?.focus(); };
    focus();
    const onClick = (e) => { if (e.target.tagName!=='INPUT' && e.target.tagName!=='BUTTON' && !e.target.closest('button')) setTimeout(focus,50); };
    const onKey = () => { if (!showAddProduct && !showDefectModal && !showUndoConfirm && document.activeElement!==scanRef.current) scanRef.current?.focus(); };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey); };
  }, [activeSession, sessionData, showAddProduct, showDefectModal, showUndoConfirm]);

  const openImagePreview = (src, name) => {
    if (!src) return;
    setImagePreview({ src, name });
  };

  const closeImagePreview = () => {
    setImagePreview(null);
    if (activeSession && sessionData?.status === 'active') {
      setTimeout(() => scanRef.current?.focus(), 50);
    }
  };

  const handleCreateSession = async (orderId=null) => { try { const {data} = await api.post('/receiving/sessions',{purchaseOrderId:orderId}); showToast('Создано','success'); setShowOrders(false); loadSessions(); loadSession(data.sessionId); } catch(err) { showToast('Ошибка','error'); }};
  const handleScan = async (barcode) => { if (!barcode.trim()) return; try { const {data} = await api.post(`/receiving/sessions/${activeSession}/scan`,{barcode:barcode.trim()}); if(data.isExtra){playSound('warning');showToast(`⚠️ ПЕРЕСОРТ: ${data.product} +${data.received}`,'error');}else{playSound('success');showToast(`✓ ${data.product}: ${data.received}/${data.ordered}`,'success');} setCanUndo(true); loadSession(activeSession); } catch(err) { playSound('error'); showToast(err.response?.data?.error||'Не найден','error'); }};
  const handleUndo = async () => { try { const {data} = await api.post(`/receiving/sessions/${activeSession}/undo`); playSound('warning'); showToast(data.message,'success'); setCanUndo(false); setShowUndoConfirm(false); loadSession(activeSession); } catch(err) { showToast('Ошибка','error'); }};
  const handleAddProduct = async () => { if (!selected) return; try { await api.post(`/receiving/sessions/${activeSession}/items`,{productId:selected.id,quantity:qty,isExtra:true}); playSound('warning'); showToast(`Пересорт: ${selected.name} +${qty}`,'success'); setShowAddProduct(false); setSelected(null); setQty(1); setSearch(''); loadSession(activeSession); } catch(err) { showToast('Ошибка','error'); }};
  const handleSetDefect = async () => { if (!showDefectModal) return; try { await api.post(`/receiving/sessions/${activeSession}/items/${showDefectModal.id}/defect`,{defect_qty:defectQty}); showToast(`Брак: ${defectQty} шт`,'success'); setShowDefectModal(null); setDefectQty(0); loadSession(activeSession); } catch(err) { showToast('Ошибка','error'); }};
  const handleComplete = async () => { try { const {data} = await api.post(`/receiving/sessions/${activeSession}/complete`); playSound('complete'); showToast(data.message,'success'); setActiveSession(null); setSessionData(null); loadSessions(); } catch(err) { showToast(err.response?.data?.message||'Ошибка','error'); }};

  if (activeSession && sessionData) {
    const items = sessionData.items || [];
    const orderedItems = items.filter(i => !i.is_extra);
    const extraItems = items.filter(i => i.is_extra);
    const defectItems = items.filter(i => i.defect_qty > 0);
    const totalReceived = items.reduce((s,i) => s + (i.received_qty||0), 0);
    const totalDefects = items.reduce((s,i) => s + (i.defect_qty||0), 0);
    const totalOrdered = sessionData.total_ordered || 0;
    const progress = totalOrdered > 0 ? Math.min((totalReceived/totalOrdered)*100, 100) : 0;

    return (
      <div className="max-w-6xl mx-auto px-4 py-4">
        <div className="bg-white rounded-2xl shadow-sm border p-4 mb-4">
          <div className="flex items-center gap-4 flex-wrap">
            <button onClick={()=>{setActiveSession(null);setSessionData(null);}} className="btn-secondary p-2.5 rounded-xl"><ArrowLeft className="w-5 h-5"/></button>
            <div className="flex-1 min-w-[200px]">
              <h2 className="font-bold text-xl">{sessionData.name}</h2>
              <div className="flex items-center gap-3 text-sm text-gray-500 mt-1 flex-wrap">
                {sessionData.supplier_name && <span className="flex items-center gap-1"><Truck className="w-4 h-4"/> {sessionData.supplier_name}</span>}
                <span>Принято: <strong>{totalReceived}</strong>{totalOrdered>0&&` / ${totalOrdered}`}</span>
                {totalDefects>0 && <span className="text-red-600">Брак: <strong>{totalDefects}</strong></span>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {canUndo && sessionData.status==='active' && <button onClick={()=>setShowUndoConfirm(true)} className="px-4 py-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 font-medium text-sm">↩ Отменить</button>}
              {sessionData.status==='active' && <button onClick={handleComplete} disabled={totalReceived===0} className={`flex items-center gap-2 px-5 py-3 rounded-xl font-medium ${totalReceived>0?'bg-emerald-500 text-white hover:bg-emerald-600':'bg-gray-100 text-gray-400 cursor-not-allowed'}`}><CheckCircle className="w-5 h-5"/> Завершить приёмку</button>}
            </div>
          </div>
          {totalOrdered>0 && <div className="mt-4"><div className="flex justify-between text-sm mb-1"><span className="text-gray-500">Прогресс</span><span className="font-bold text-emerald-600">{Math.round(progress)}%</span></div><div className="h-2 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-emerald-500" style={{width:`${progress}%`}}/></div></div>}
        </div>

        {sessionData.status==='active' && (
          <div className="bg-gradient-to-r from-blue-500 to-blue-600 rounded-2xl p-5 mb-4 shadow-lg">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-white"><div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center"><Scan className="w-5 h-5"/></div><div><span className="font-semibold text-lg">Сканирование</span><p className="text-blue-100 text-xs">Автофокус • Звук</p></div></div>
              <button onClick={()=>setShowAddProduct(true)} className="bg-white/20 hover:bg-white/30 text-white px-4 py-2 rounded-xl text-sm font-medium flex items-center gap-2"><Plus className="w-4 h-4"/> Добавить излишки</button>
            </div>
            <input ref={scanRef} type="text" placeholder="Отсканируйте штрихкод..." className="w-full px-5 py-4 rounded-xl text-xl font-mono bg-white focus:ring-4 focus:ring-white/30" autoFocus onKeyDown={e=>{if(e.key==='Enter'&&e.target.value){handleScan(e.target.value);e.target.value='';}}}/>
          </div>
        )}

        <div className="grid lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <div className="bg-white rounded-2xl shadow-sm border overflow-hidden">
              <div className="bg-gray-50 px-4 py-3 border-b"><h3 className="font-semibold flex items-center gap-2"><Package className="w-5 h-5 text-blue-600"/> Ожидаемые <span className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full">{orderedItems.length}</span></h3></div>
              <div className="divide-y max-h-[500px] overflow-auto">
                {orderedItems.length===0 ? <div className="p-8 text-center text-gray-400"><Package className="w-12 h-12 mx-auto mb-2 opacity-50"/><p>Сканируйте товары</p></div> : orderedItems.map(item=>{
                  const isComplete = item.received_qty >= item.ordered_qty;
                  const hasDefect = item.defect_qty > 0;
                  const imageSrc = getProductImageUrl(item.product_id) || getProxiedImageUrl(item.image_url);
                  return (
                    <div key={item.id} className={`p-4 ${hasDefect?'bg-red-50':isComplete?'bg-emerald-50':''}`}>
                      <div className="flex gap-4">
                        <div className="w-20 h-20 rounded-xl bg-gray-100 flex-shrink-0 flex items-center justify-center overflow-hidden border relative">
                          <Package className="w-8 h-8 text-gray-300" />
                          {imageSrc && (
                            <img
                              src={imageSrc}
                              alt={item.name}
                              className="absolute inset-0 w-full h-full object-cover cursor-zoom-in"
                              onClick={() => openImagePreview(imageSrc, item.name)}
                              onError={e=>{e.currentTarget.style.display='none';}}
                            />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm mb-1 line-clamp-2">{item.name}</p>
                          {item.barcode && <div className="inline-block bg-white rounded-lg px-3 py-1.5 border shadow-sm"><BarcodeSVG value={item.barcode} height={32}/><p className="text-xs text-center text-gray-500 font-mono mt-1">{item.barcode}</p></div>}
                          {hasDefect && <div className="mt-2 inline-flex items-center gap-1 bg-red-100 text-red-700 text-xs px-2 py-1 rounded-full"><AlertTriangle className="w-3 h-3"/> Брак: {item.defect_qty}</div>}
                        </div>
                        <div className="flex flex-col items-end justify-between">
                          <div className={`text-2xl font-bold ${hasDefect?'text-red-600':isComplete?'text-emerald-600':'text-gray-800'}`}>{item.received_qty||0} <span className="text-gray-400 font-normal">/</span> {item.ordered_qty}</div>
                          {sessionData.status==='active' && <button onClick={()=>{setShowDefectModal(item);setDefectQty(item.defect_qty||0);}} className={`text-xs px-3 py-1.5 rounded-lg font-medium ${hasDefect?'bg-red-100 text-red-700':'bg-gray-100 text-gray-600 hover:bg-red-50 hover:text-red-600'}`}>{hasDefect?`Брак: ${item.defect_qty}`:'+ Брак'}</button>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="bg-amber-50 rounded-2xl border-2 border-amber-200 overflow-hidden">
              <div className="bg-amber-100 px-4 py-3 border-b border-amber-200"><h3 className="font-semibold text-amber-800 flex items-center gap-2"><AlertTriangle className="w-5 h-5"/> Пересорт {extraItems.length>0&&<span className="bg-amber-200 text-xs px-2 py-0.5 rounded-full">{extraItems.length}</span>}</h3><p className="text-xs text-amber-600 mt-0.5">→ Оприходование</p></div>
              <div className="divide-y divide-amber-200 max-h-[250px] overflow-auto">
                {extraItems.length===0 ? <div className="p-6 text-center text-amber-600/60"><p className="text-sm">Нет излишков</p></div> : extraItems.map(item=>{
                  const imageSrc = getProductImageUrl(item.product_id) || getProxiedImageUrl(item.image_url);
                  return (
                    <div key={item.id} className="p-3 flex items-center gap-3">
                      <div className="w-12 h-12 rounded-lg bg-amber-100 flex-shrink-0 flex items-center justify-center overflow-hidden relative">
                        <Package className="w-5 h-5 text-amber-500"/>
                        {imageSrc && (
                          <img
                            src={imageSrc}
                            alt={item.name}
                            className="absolute inset-0 w-full h-full object-cover cursor-zoom-in"
                            onClick={() => openImagePreview(imageSrc, item.name)}
                            onError={e=>{e.currentTarget.style.display='none';}}
                          />
                        )}
                      </div>
                      <div className="flex-1 min-w-0"><p className="font-medium text-sm truncate text-amber-900">{item.name}</p><p className="text-xs text-amber-600 font-mono">{item.barcode||item.article}</p></div>
                      <div className="text-xl font-bold text-amber-600">+{item.received_qty}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {defectItems.length>0 && (
              <div className="bg-red-50 rounded-2xl border-2 border-red-200 overflow-hidden">
                <div className="bg-red-100 px-4 py-3 border-b border-red-200"><h3 className="font-semibold text-red-800 flex items-center gap-2"><AlertTriangle className="w-5 h-5"/> Брак <span className="bg-red-200 text-xs px-2 py-0.5 rounded-full">{totalDefects}</span></h3></div>
                <div className="p-3 space-y-2">{defectItems.map(item=><div key={item.id} className="flex justify-between items-center bg-white/50 rounded-lg px-3 py-2"><span className="text-sm text-red-800">{item.article||item.name}</span><span className="font-bold text-red-700">{item.defect_qty}</span></div>)}</div>
              </div>
            )}

            <div className="bg-white rounded-2xl border p-4">
              <h3 className="font-semibold text-gray-700 mb-3">Итого</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-500">Ожидалось:</span><span>{totalOrdered}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Принято:</span><span className="text-emerald-600">{orderedItems.reduce((s,i)=>s+(i.received_qty||0),0)}</span></div>
                {extraItems.length>0 && <div className="flex justify-between"><span className="text-gray-500">Излишки:</span><span className="text-amber-600">+{extraItems.reduce((s,i)=>s+(i.received_qty||0),0)}</span></div>}
                {totalDefects>0 && <div className="flex justify-between"><span className="text-gray-500">Брак:</span><span className="text-red-600">{totalDefects}</span></div>}
              </div>
            </div>
          </div>
        </div>

        {showUndoConfirm && <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setShowUndoConfirm(false)}><div className="bg-white rounded-2xl p-6 max-w-sm w-full" onClick={e=>e.stopPropagation()}><div className="text-center mb-4"><div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4"><AlertTriangle className="w-8 h-8 text-amber-600"/></div><h2 className="text-lg font-bold">Отменить последнее сканирование?</h2></div><div className="flex gap-3"><button onClick={()=>setShowUndoConfirm(false)} className="flex-1 py-3 rounded-xl border-2 font-medium hover:bg-gray-50">Нет</button><button onClick={handleUndo} className="flex-1 py-3 rounded-xl bg-amber-500 text-white font-medium">Да</button></div></div></div>}

        {imagePreview && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={closeImagePreview}>
            <div className="bg-white rounded-2xl p-4 max-w-3xl w-full max-h-[90vh] overflow-auto" onClick={e=>e.stopPropagation()}>
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h3 className="font-semibold">{imagePreview.name || 'Фото товара'}</h3>
                  <p className="text-xs text-gray-500">Нажмите вне окна, чтобы закрыть</p>
                </div>
                <button className="btn-secondary text-sm" onClick={closeImagePreview}>Закрыть</button>
              </div>
              <img src={imagePreview.src} alt={imagePreview.name || 'Фото товара'} className="w-full h-auto rounded-xl"/>
            </div>
          </div>
        )}

        {showDefectModal && <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setShowDefectModal(null)}><div className="bg-white rounded-2xl p-6 max-w-sm w-full" onClick={e=>e.stopPropagation()}><div className="flex items-center gap-3 mb-4"><div className="w-12 h-12 bg-red-100 rounded-xl flex items-center justify-center"><AlertTriangle className="w-6 h-6 text-red-600"/></div><div><h2 className="text-lg font-bold">Указать брак</h2><p className="text-sm text-gray-500">{showDefectModal.article||'—'}</p></div></div><p className="text-sm text-gray-600 mb-4">{showDefectModal.name}</p><div className="flex items-center justify-center gap-4 mb-4 py-4 bg-gray-50 rounded-xl"><button onClick={()=>setDefectQty(Math.max(0,defectQty-1))} className="w-12 h-12 rounded-xl bg-white border-2 flex items-center justify-center"><Minus className="w-5 h-5"/></button><span className="text-4xl font-bold text-red-600 w-20 text-center">{defectQty}</span><button onClick={()=>setDefectQty(defectQty+1)} className="w-12 h-12 rounded-xl bg-white border-2 flex items-center justify-center"><Plus className="w-5 h-5"/></button></div><div className="flex gap-3"><button onClick={()=>setShowDefectModal(null)} className="flex-1 py-3 rounded-xl border-2 font-medium">Отмена</button><button onClick={handleSetDefect} className="flex-1 py-3 rounded-xl bg-red-600 text-white font-medium">Сохранить</button></div></div></div>}

        {showAddProduct && <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setShowAddProduct(false)}><div className="bg-white rounded-2xl p-5 max-w-lg w-full max-h-[85vh] flex flex-col" onClick={e=>e.stopPropagation()}><div className="flex items-center gap-3 mb-4"><div className="w-12 h-12 bg-amber-100 rounded-xl flex items-center justify-center"><Plus className="w-6 h-6 text-amber-600"/></div><div><h2 className="text-lg font-bold">Добавить излишки</h2><p className="text-sm text-gray-500">Сканируйте или найдите</p></div></div><div className="bg-amber-50 rounded-xl p-3 mb-3 border border-amber-200"><div className="flex items-center gap-2 mb-2"><Scan className="w-4 h-4 text-amber-600"/><span className="text-sm font-medium text-amber-700">Сканирование</span></div><input type="text" placeholder="Штрихкод..." className="w-full px-3 py-2 rounded-lg border border-amber-300 text-sm font-mono" autoFocus onKeyDown={async(e)=>{if(e.key==='Enter'&&e.target.value){const bc=e.target.value.trim();e.target.value='';try{const{data}=await api.post(`/receiving/sessions/${activeSession}/scan`,{barcode:bc});playSound('warning');showToast(`Пересорт: ${data.product}`,'success');setCanUndo(true);loadSession(activeSession);}catch(err){playSound('error');showToast('Не найден','error');}}}}/></div><div className="relative mb-3"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400"/><input type="text" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Или найдите..." className="w-full pl-10 pr-4 py-3 rounded-xl border-2"/></div><div className="flex-1 overflow-auto space-y-2 mb-3">{products.map(p=>(<div key={p.id} onClick={()=>setSelected(p)} className={`p-3 rounded-xl cursor-pointer flex items-center gap-3 ${selected?.id===p.id?'bg-amber-50 border-2 border-amber-400':'bg-gray-50 border-2 border-transparent'}`}><Package className="w-10 h-10 text-gray-400"/><div className="flex-1"><p className="font-medium text-sm truncate">{p.name}</p><p className="text-xs text-gray-500">{p.barcode}</p></div>{selected?.id===p.id&&<CheckCircle className="w-5 h-5 text-amber-500"/>}</div>))}</div>{selected&&<div className="flex items-center gap-3 p-4 bg-amber-50 rounded-xl border-2 border-amber-200"><span className="flex-1 text-sm truncate">{selected.name}</span><button onClick={()=>setQty(Math.max(1,qty-1))} className="w-10 h-10 rounded-lg bg-white border flex items-center justify-center"><Minus className="w-4 h-4"/></button><span className="w-12 text-center font-bold">{qty}</span><button onClick={()=>setQty(qty+1)} className="w-10 h-10 rounded-lg bg-white border flex items-center justify-center"><Plus className="w-4 h-4"/></button><button onClick={handleAddProduct} className="px-5 py-2.5 rounded-xl bg-amber-500 text-white font-medium">Добавить</button></div>}</div></div>}
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-4">
      <div className="flex items-center justify-between mb-6"><h1 className="text-2xl font-bold">Приёмка</h1><div className="flex gap-2">{orders.length>0&&<button onClick={()=>setShowOrders(true)} className="btn-secondary flex items-center gap-2"><Truck className="w-5 h-5"/> Из заказа ({orders.length})</button>}<button onClick={()=>handleCreateSession()} className="btn-primary flex items-center gap-2"><Plus className="w-5 h-5"/> Новая</button></div></div>
      {showOrders && <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={()=>setShowOrders(false)}><div className="bg-white rounded-2xl p-5 max-w-lg w-full max-h-[80vh] flex flex-col" onClick={e=>e.stopPropagation()}><h2 className="text-xl font-bold mb-4">Выберите заказ</h2><div className="flex-1 overflow-auto space-y-2">{orders.map(o=>(<div key={o.id} onClick={()=>handleCreateSession(o.id)} className="p-4 rounded-xl bg-gray-50 hover:bg-blue-50 cursor-pointer border-2 border-transparent hover:border-blue-400"><div className="flex justify-between mb-1"><p className="font-semibold">{o.name}</p><span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{o.items_count}</span></div><p className="text-sm text-gray-600">{o.supplier_name}</p></div>))}{orders.length===0&&<p className="text-center py-8 text-gray-500">Нет заказов</p>}</div></div></div>}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">{sessions.map(s=>{const p=s.total_ordered>0?(s.total_received/s.total_ordered)*100:0;return(<div key={s.id} onClick={()=>loadSession(s.id)} className={`bg-white rounded-2xl border-2 p-4 cursor-pointer hover:shadow-lg ${s.status==='completed'?'opacity-60':''}`}><div className="flex justify-between items-start mb-3"><div><h3 className="font-semibold">{s.name}</h3>{s.supplier_name&&<p className="text-sm text-gray-500">{s.supplier_name}</p>}</div><span className={`text-xs px-2.5 py-1 rounded-full ${s.status==='active'?'bg-blue-100 text-blue-700':'bg-emerald-100 text-emerald-700'}`}>{s.status==='active'?'Активна':'Завершена'}</span></div><p className="text-sm text-gray-500 mb-3">{s.total_received||0}/{s.total_ordered||0}</p>{s.total_ordered>0&&<div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className={`h-full ${s.status==='completed'?'bg-emerald-500':'bg-blue-500'}`} style={{width:`${Math.min(p,100)}%`}}/></div>}</div>);})}</div>
      {sessions.length===0&&<div className="text-center py-16 text-gray-500"><Truck className="w-16 h-16 mx-auto mb-4 text-gray-300"/><p className="text-lg">Нет сессий</p></div>}
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState('products');
  const [toast, setToast] = useState(null);
  const sync = useSync();
  const showToast = (message, type='info') => setToast({message,type});
  return (
    <div className="min-h-screen pb-16">
      <Header page={page} setPage={setPage} sync={sync}/>
      {page==='products'&&<ProductsPage showToast={showToast}/>}
      {page==='packing'&&<PackingPage showToast={showToast}/>}
      {page==='receiving'&&<ReceivingPage showToast={showToast}/>}
      {toast&&<Toast {...toast} onClose={()=>setToast(null)}/>}
    </div>
  );
}
