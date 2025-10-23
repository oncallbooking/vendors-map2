/* script.js
   Plotly + Leaflet dashboard with Excel/CSV upload
   - 10 chart types (Plotly)
   - Sidebar filters (select all + checkboxes)
   - True fullscreen for chart & map
   - Export CSV/XLSX, print
*/

(() => {
  // State
  let raw = [];         // original rows
  let view = [];        // filtered rows
  let meta = { headers:[], numeric:[], categorical:[] };
  let map, markersLayer;
  let lastPlotData = null;

  // DOM
  const fileInput = document.getElementById('fileInput');
  const loadDemo = document.getElementById('loadDemo');
  const filtersContainer = document.getElementById('filtersContainer');
  const chartType = document.getElementById('chartType');
  const applyBtn = document.getElementById('applyBtn');
  const topNInput = document.getElementById('topN');
  const chartDiv = document.getElementById('chart');
  const mapDiv = document.getElementById('map');
  const tableHead = document.getElementById('tableHead');
  const tableBody = document.getElementById('tableBody');
  const rowCount = document.getElementById('rowCount');
  const colCount = document.getElementById('colCount');
  const downloadChartBtn = document.getElementById('downloadChart');
  const exportCsvBtn = document.getElementById('exportCsv');
  const exportXlsxBtn = document.getElementById('exportXlsx');
  const chartFs = document.getElementById('chartFs');
  const mapFs = document.getElementById('mapFs');
  const printBtn = document.getElementById('printBtn');
  const globalSearch = document.getElementById('globalSearch');
  const tableSearch = document.getElementById('tableSearch');
  const rowsPerPage = document.getElementById('rowsPerPage');
  const resetFilters = document.getElementById('resetFilters');

  // Init
  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    attachEvents();
    loadDemoData();
  });

  function attachEvents(){
    fileInput.addEventListener('change', handleFile);
    loadDemo.addEventListener('click', loadDemoData);
    applyBtn.addEventListener('click', applyFilters);
    chartType.addEventListener('change', renderChart);
    topNInput.addEventListener('change', renderChart);
    downloadChartBtn.addEventListener('click', downloadChart);
    exportCsvBtn.addEventListener('click', exportCSV);
    exportXlsxBtn.addEventListener('click', exportXLSX);
    chartFs.addEventListener('click', ()=> toggleFullscreen(chartDiv.parentElement));
    mapFs.addEventListener('click', ()=> { toggleFullscreen(mapDiv.parentElement); setTimeout(()=> map.invalidateSize(), 300); });
    printBtn.addEventListener('click', printDashboard);
    globalSearch.addEventListener('input', debounce(applyFilters, 300));
    tableSearch.addEventListener('input', debounce(renderTable, 200));
    rowsPerPage.addEventListener('change', renderTable);
    resetFilters.addEventListener('click', ()=> { resetAllFilters(); applyFilters(); });
  }

  // ---------- File handling ----------
  async function handleFile(e){
    const f = e.target.files[0];
    if(!f) return;
    const name = f.name.toLowerCase();
    try {
      if(name.endsWith('.csv')){
        const text = await f.text();
        const parsed = Papa.parse(text, { header:true, dynamicTyping:true, skipEmptyLines:true });
        raw = parsed.data;
      } else {
        const ab = await f.arrayBuffer();
        const wb = XLSX.read(ab, { type:'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        raw = XLSX.utils.sheet_to_json(ws, { defval: null });
      }
      postLoad();
    } catch (err) {
      alert('Failed to parse file: ' + err.message);
    }
  }

  function postLoad(){
    if(!raw || !raw.length){ alert('No data'); return; }
    detectMeta();
    buildFilters();
    resetAllFilters();
    applyFilters();
    exportCsvBtn.disabled = false;
    exportXlsxBtn.disabled = false;
  }

  // ---------- Meta detection ----------
  function detectMeta(){
    const headers = Object.keys(raw[0] || {});
    meta.headers = headers;
    meta.numeric = []; meta.categorical = [];
    headers.forEach(h=>{
      let num=0, tot=0;
      for(let i=0;i<Math.min(200,raw.length); i++){
        const v = raw[i][h]; if(v===null||v===undefined||v===''){ tot++; continue; } tot++;
        if(typeof v === 'number' && isFinite(v)) num++; else if(!isNaN(parseFloat(v))) num++;
      }
      if(tot>0 && (num/tot) > 0.6) meta.numeric.push(h); else meta.categorical.push(h);
    });
    rowCount.textContent = raw.length;
    colCount.textContent = meta.headers.length;
  }

  // ---------- Filters UI ----------
  function buildFilters(){
    filtersContainer.innerHTML = '';
    // choose up to first 5 categorical fields (or first 3 headers)
    const groups = meta.categorical.length ? meta.categorical.slice(0,5) : meta.headers.slice(0,3);
    groups.forEach(col => {
      const wrapper = document.createElement('div');
      wrapper.className = 'filter-group mb-2';
      const title = document.createElement('div');
      title.className = 'd-flex justify-content-between align-items-center mb-1';
      title.innerHTML = `<strong>${col}</strong><span class="select-all text-primary" data-col="${col}" style="cursor:pointer">Select All</span>`;
      wrapper.appendChild(title);
      const values = Array.from(new Set(raw.map(r => (r[col] ?? '') + '').filter(Boolean))).sort();
      const list = document.createElement('div');
      list.className = 'filter-values';
      values.forEach((v, idx) => {
        const id = `f_${col}_${idx}`;
        const div = document.createElement('div');
        div.className = 'form-check';
        div.innerHTML = `<input class="form-check-input filter-checkbox" data-col="${col}" type="checkbox" id="${id}" value="${escapeHtml(v)}" checked>
                         <label class="form-check-label" for="${id}">${escapeHtml(v)}</label>`;
        list.appendChild(div);
      });
      wrapper.appendChild(list);
      filtersContainer.appendChild(wrapper);
    });

    // event wiring
    filtersContainer.querySelectorAll('.select-all').forEach(s => {
      s.addEventListener('click', () => {
        const col = s.dataset.col;
        const cbs = Array.from(document.querySelectorAll(`.filter-checkbox[data-col="${col}"]`));
        const all = cbs.every(cb => cb.checked);
        cbs.forEach(cb => cb.checked = !all);
        applyFilters();
      });
    });
    filtersContainer.querySelectorAll('.filter-checkbox').forEach(cb => cb.addEventListener('change', () => applyFilters()));
  }

  function getActiveValues(col){
    return Array.from(document.querySelectorAll(`.filter-checkbox[data-col="${col}"]:checked`)).map(i => i.value);
  }
  function resetAllFilters(){
    Array.from(document.querySelectorAll('.filter-checkbox')).forEach(cb => cb.checked = true);
    globalSearch.value = '';
  }

  // ---------- Filters logic ----------
  function applyFilters(){
    if(!raw.length) return;
    const groups = Array.from(document.querySelectorAll('.filter-group')).map(g => g.querySelector('strong').textContent);
    let filtered = raw.slice();
    groups.forEach(col => {
      const active = getActiveValues(col);
      if(active.length && active.length !== document.querySelectorAll(`.filter-checkbox[data-col="${col}"]`).length){
        filtered = filtered.filter(r => active.includes((r[col] ?? '') + ''));
      }
    });
    const q = (globalSearch.value || '').toLowerCase().trim();
    if(q){
      filtered = filtered.filter(r => Object.values(r).some(v => (v===null||v===undefined) ? false : (''+v).toLowerCase().includes(q)));
    }
    view = filtered;
    renderTable();
    renderChart();
    renderMap();
  }

  // ---------- Chart (Plotly) ----------
  function renderChart(){
    if(!view || !view.length){ Plotly.purge(chartDiv); downloadChartBtn.disabled = true; return; }
    const type = chartType.value;
    const topN = Math.max(1, Number(topNInput.value) || 10);
    const cat = meta.categorical[0] || meta.headers[0];
    const num = meta.numeric[0] || meta.headers.find(h=>h!==cat) || meta.headers[0];

    const agg = {};
    view.forEach(r => {
      const k = (r[cat] ?? 'Unknown') + '';
      const v = Number(r[num]) || 0;
      agg[k] = (agg[k] || 0) + v;
    });
    const entries = Object.entries(agg).sort((a,b)=>b[1]-a[1]).slice(0, topN);
    const labels = entries.map(e=>e[0]);
    const values = entries.map(e=>e[1]);
    const colors = labels.map((_,i)=> ['#2563eb','#06b6d4','#f97316','#10b981','#7c3aed','#ef4444','#f59e0b','#0ea5a4','#8b5cf6','#e11d48'][i%10]);

    let data = [], layout = { margin:{t:40,l:50,r:30,b:80}, legend:{orientation:'h'} };

    switch(type){
      case 'bar':
        data = [{ type:'bar', x: labels, y: values, marker:{color:colors} }];
        break;
      case 'hbar':
        data = [{ type:'bar', x: values, y: labels, orientation: 'h', marker:{color:colors} }];
        break;
      case 'line':
        data = [{ type:'scatter', mode:'lines+markers', x: labels, y: values, line:{color:colors[0]} }];
        break;
      case 'area':
        data = [{ type:'scatter', mode:'lines', x: labels, y: values, fill:'tozeroy', line:{color:colors[0]}, marker:{color:colors[0]} }];
        break;
      case 'pie':
        data = [{ type:'pie', labels, values, marker:{colors} }];
        break;
      case 'donut':
        data = [{ type:'pie', labels, values, hole:0.45, marker:{colors} }];
        break;
      case 'polar':
        data = [{ type:'barpolar', r: values, theta: labels, marker:{color:colors} }];
        layout.polar = { radialaxis:{visible:true} };
        break;
      case 'radar':
        data = [{ type:'scatterpolar', r: values.concat(values[0]), theta: labels.concat(labels[0]), fill:'toself', marker:{color:colors[0]} }];
        layout.polar = { radialaxis:{visible:true} };
        break;
      case 'bubble':
        data = labels.map((l,i)=>({ x:[i+1], y:[values[i]], mode:'markers', marker:{size: Math.max(6, Math.sqrt(values[i]) / 10), color:colors[i]}, name: l }));
        layout.xaxis = { title: cat };
        layout.yaxis = { title: num };
        break;
      case 'scatter':
        data = [{ type:'scatter', x: labels.map((_,i)=>i+1), y: values, mode:'markers', marker:{size:8, color:colors[0]} }];
        layout.xaxis = { title: cat };
        layout.yaxis = { title: num };
        break;
    }

    Plotly.newPlot(chartDiv, data, layout, {responsive:true}).then(gd=>{
      lastPlotData = { data, layout };
      downloadChartBtn.disabled = false;
    }).catch(err => console.error(err));
  }

  function downloadChart(){
    if(!lastPlotData) return;
    Plotly.toImage(chartDiv, { format:'png', width: 1400, height: 800 }).then(url => {
      const a = document.createElement('a'); a.href = url; a.download = 'chart.png'; a.click();
    });
  }

  // ---------- Map ----------
  function initMap(){
    map = L.map(mapDiv).setView([22.0,79.0], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap' }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
  }

  function renderMap(){
    markersLayer.clearLayers();
    if(!view || !view.length){ mapStatus('No pins'); return; }
    const latKey = meta.headers.find(h=>/lat|latitude/i.test(h));
    const lonKey = meta.headers.find(h=>/lon|lng|longitude/i.test(h));
    if(latKey && lonKey){
      view.forEach(r=>{
        const lat = parseFloat(r[latKey]), lon = parseFloat(r[lonKey]);
        if(isFinite(lat) && isFinite(lon)){
          addMarker(lat, lon, r);
        }
      });
      fitMarkers();
      mapStatus(`${markersLayer.getLayers().length} pins`);
      return;
    }
    // fallback: geocode limited; look for place column
    const placeKey = meta.headers.find(h=>/city|town|state|district|place|location/i.test(h));
    if(!placeKey){ mapStatus('No location field'); return; }
    mapStatus('Geocoding (limited)...');
    const unique = Array.from(new Set(view.map(r => (r[placeKey]||'')+ '').filter(Boolean))).slice(0,40);
    geocodeAndPlot(unique, placeKey);
  }

  async function geocodeAndPlot(unique, key){
    const geos = {};
    for(let i=0;i<unique.length;i++){
      const q = unique[i];
      try {
        await delay(650);
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q + ' India')}`);
        if(!res.ok) continue;
        const j = await res.json();
        if(j && j[0]) geos[q]= { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon) };
      } catch(e){ console.warn('geo fail', e); }
    }
    view.forEach(r => {
      const place = (r[key]||'')+ '';
      const g = geos[place];
      if(g) addMarker(g.lat, g.lon, r);
    });
    fitMarkers();
    mapStatus(`${markersLayer.getLayers().length} pins`);
  }

  function addMarker(lat, lon, row){
    const html = Object.entries(row).map(([k,v]) => `<div style="font-size:.9rem"><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}</div>`).join('');
    const m = L.marker([lat, lon]);
    m.bindPopup(html);
    m.addTo(markersLayer);
  }

  function fitMarkers(){
    if(!markersLayer.getLayers().length) return;
    const g = L.featureGroup(markersLayer.getLayers());
    map.fitBounds(g.getBounds().pad(0.15));
  }

  function mapStatus(txt){ document.getElementById('mapStatus').textContent = txt; }

  // ---------- Table ----------
  function renderTable(){
    tableHead.innerHTML = '';
    tableBody.innerHTML = '';
    const headers = meta.headers.length ? meta.headers : (view[0] ? Object.keys(view[0]) : []);
    // header
    const trh = document.createElement('tr');
    headers.forEach(h => {
      const th = document.createElement('th'); th.textContent = h; trh.appendChild(th);
    });
    tableHead.appendChild(trh);
    // rows
    const q = (tableSearch.value || '').toLowerCase().trim();
    const filtered = (view || []).filter(r => {
      if(!q) return true;
      return Object.values(r).some(v => (v===null||v===undefined)?false: (''+v).toLowerCase().includes(q));
    });
    const page = Number(rowsPerPage.value) || 25;
    if(!filtered.length){ const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = headers.length; td.className='text-center text-muted py-3'; td.textContent = 'No records'; tr.appendChild(td); tableBody.appendChild(tr); return; }
    filtered.slice(0, page).forEach(r=>{
      const tr = document.createElement('tr');
      headers.forEach(h => {
        const td = document.createElement('td'); td.innerHTML = escapeHtml(r[h] ?? ''); tr.appendChild(td);
      });
      tableBody.appendChild(tr);
    });
  }

  // ---------- Exports & Print ----------
  function exportCSV(){
    if(!view.length) return alert('No data');
    const hdr = meta.headers;
    const rows = view.map(r => hdr.map(h => `"${String(r[h] ?? '').replace(/"/g,'""')}"`).join(','));
    const csv = [hdr.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type:'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'export.csv'; a.click();
  }

  function exportXLSX(){
    if(!view.length) return alert('No data');
    const ws = XLSX.utils.json_to_sheet(view);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Export');
    XLSX.writeFile(wb, 'export.xlsx');
  }

  async function printDashboard(){
    const main = document.querySelector('main');
    const canvas = await html2canvas(main, { scale: 1.5, useCORS:true });
    const img = canvas.toDataURL('image/jpeg', 0.95);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('landscape','pt','a4');
    const w = pdf.internal.pageSize.getWidth();
    const h = (canvas.height * w) / canvas.width;
    pdf.addImage(img, 'JPEG', 10, 10, w-20, h-20);
    pdf.save('dashboard.pdf');
  }

  // ---------- Utilities ----------
  function escapeHtml(s){ if(s===null||s===undefined) return ''; return (''+s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
  function debounce(fn, ms){ let t; return (...args) => { clearTimeout(t); t = setTimeout(()=> fn(...args), ms); }; }
  function delay(ms){ return new Promise(r=>setTimeout(r, ms)); }
  function toggleFullscreen(el){
    if(!document.fullscreenElement) el.requestFullscreen && el.requestFullscreen();
    else document.exitFullscreen && document.exitFullscreen();
  }

  // ---------- Demo data ----------
  function loadDemoData(){
    raw = [
      { Name:'Asha Mart', Category:'Retail', Subcategory:'Elastic Rail Clips', City:'Mumbai', State:'Maharashtra', Latitude:19.075983, Longitude:72.877655, Revenue:120000, Owner:'Rajesh' },
      { Name:'Kala Wholesalers', Category:'Wholesale', Subcategory:'Fish Plates', City:'Surat', State:'Gujarat', Latitude:21.170240, Longitude:72.831062, Revenue:300000, Owner:'Deepak' },
      { Name:'Suryan Services', Category:'Services', Subcategory:'Maintenance', City:'Chennai', State:'Tamil Nadu', Latitude:13.082680, Longitude:80.270718, Revenue:90000, Owner:'Suryan' },
      { Name:'Bengal Retail', Category:'Retail', Subcategory:'Fish Plates', City:'Kolkata', State:'West Bengal', Latitude:22.572646, Longitude:88.363895, Revenue:150000, Owner:'Bengal Owner' },
      { Name:'Greenfield Trade', Category:'Wholesale', Subcategory:'Rail Parts', City:'New Delhi', State:'Delhi', Latitude:28.613939, Longitude:77.209021, Revenue:210000, Owner:'Green' }
    ];
    postLoad();
  }

  function postLoad(){
    detectMeta();
    buildFilters();
    resetAllFilters();
    applyFilters();
    exportCsvBtn.disabled = false;
    exportXlsxBtn.disabled = false;
  }

  // Helpers to call from outside
  window.exportCSV = exportCSV;
  window.exportXLSX = exportXLSX;

})();
