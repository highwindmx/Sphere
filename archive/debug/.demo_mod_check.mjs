
    import * as Cesium from 'cesium';

    const $ = (s) => document.querySelector(s);
    const toast = (msg, ms = 2400) => {
      const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
      clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, ms);
    };
    const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b > 1e3 ? (b / 1e3).toFixed(0) + ' KB' : b + 'B';
    const fmtN = (n) => n >= 1e8 ? (n / 1e8).toFixed(1) + ' 亿' : n >= 1e4 ? (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + ' 万' : n.toLocaleString();

    /* ===== 地球 ===== */
    // 占位 token：消掉 Cesium Ion 默认 token 警告条（demo 不使用任何 Ion 资产）
    Cesium.Ion.defaultAccessToken = 'demo-no-ion-assets';
    const viewer = new Cesium.Viewer('globe', {
      baseLayer: false, animation: false, timeline: false,
      geocoder: false, homeButton: false, sceneModePicker: false,
      navigationHelpButton: false, fullscreenButton: false,
      infoBox: false, selectionIndicator: false,
    });
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#dfe6ef');
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(104, 30, 7800000) });

    /* ===== 瓦片数预估（XYZ 墨卡托公式；GIBS 用其非二分网格表） ===== */
    const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * Math.pow(2, z));
    const lat2y = (lat, z) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
    const countXyz = (zmin, zmax, bbox) => {
      let n = 0;
      for (let z = zmin; z <= zmax; z++) {
        if (bbox) {
          const x0 = lon2x(bbox.w, z), x1 = lon2x(bbox.e, z);
          const y0 = lat2y(bbox.n, z), y1 = lat2y(bbox.s, z);
          n += Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1);
        } else {
          n += Math.pow(4, z);
        }
      }
      return n;
    };
    const GIBS_GRID = [2, 6, 15, 50, 200, 800, 3200, 12800]; // 每级瓦片数（COLS×ROWS）
    const countGibs = (zmin, zmax) => GIBS_GRID.slice(zmin, zmax + 1).reduce((a, b) => a + b, 0);

    /* ===== 源数据（与主应用 IMAGERY_SOURCES 对齐） =====
       scanKey → /api/downloader/scan 真实统计字段；
       avgKB → 本地缓存实测均瓦片大小（2026-10-16 扫盘：esri 11.6 / eox 10.2 /
                tianditu 13.1 / terrain 47.6；gibs 仅 1 张缓存，取名义 30KB）；
       maxZ → 源最高层级（GIBS 专用 provider 到 z7） */
    const SOURCES = [
      { id: 'tianditu', name: '天地图', grid: 'xyz', maxZ: 18, bbox: { w: 73.4, s: 3.8, e: 135.2, n: 53.6 },
        provider: () => new Cesium.UrlTemplateImageryProvider({ url: 'tiles/tianditu/{s}/{z}/{x}/{y}.jpg', subdomains: ['0','1','2','3','4','5','6','7'], tilingScheme: new Cesium.WebMercatorTilingScheme(), maximumLevel: 18 }),
        chips: ['中国区', 'z0–18', '需 key'],
        scanKey: 'tianditu', avgKB: 13.1,
        doc: 'https://lbs.tianditu.gov.cn/', docLabel: '天地图开发文档', needsKey: true },
      { id: 'esri', name: 'Esri 卫星', grid: 'xyz', maxZ: 19,
        provider: () => new Cesium.UrlTemplateImageryProvider({ url: 'tiles/esri/{z}/{x}/{y}.jpg', maximumLevel: 19 }),
        chips: ['全球', 'z0–19'],
        scanKey: 'esri', avgKB: 11.6,
        doc: 'https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9', docLabel: 'Esri World Imagery' },
      { id: 'eox', name: 'EOX S2', grid: 'xyz', maxZ: 18,
        provider: () => new Cesium.UrlTemplateImageryProvider({ url: 'tiles/eox/{z}/{x}/{y}.jpg', maximumLevel: 18 }),
        chips: ['全球', 'z0–18'],
        scanKey: 'eox', avgKB: 10.2,
        doc: 'https://s2maps.eu/', docLabel: 'Sentinel-2 无云合成' },
      { id: 'gibs', name: 'GIBS Blue Marble', grid: 'gibs', maxZ: 7,
        provider: () => new Cesium.UrlTemplateImageryProvider({ url: 'tiles/gibs/{g}/{r}/{c}.jpeg', maximumLevel: 7 }),
        chips: ['全球 ±90°', 'z0–7', '非二分网格'],
        scanKey: 'gibs', avgKB: 30,
        doc: 'https://nasa-gibs.github.io/gibs-api-docs/', docLabel: 'GIBS API 文档', note: '真机版接 gibs-provider.js' },
    ];
    const TERRAIN = { id: 'terrain', name: 'AWS Terrarium 高程', grid: 'xyz', maxZ: 14,
      chips: ['全球', 'z0–14'], scanKey: 'terrain', avgKB: 47.6,
      doc: 'https://registry.opendata.aws/terrain-tiles/', docLabel: 'AWS 开放数据' };

    const localFirst = {};   // id -> bool（默认全开：本地优先）
    const countFor = (s, zmin, zmax) => s.grid === 'gibs' ? countGibs(zmin, zmax) : countXyz(zmin, zmax, s.bbox);
    const estLabel = (s, zmin, zmax) => {
      const n = countFor(s, zmin, zmax);
      const bytes = n * s.avgKB * 1024;
      const region = s.bbox ? '中国区' : '全球';
      return `${region} z${zmin}–${zmax} ≈ ${fmtN(n)} 张 · ${fmtSize(bytes)}`;
    };
    const TIERS = [
      { key: 'skel', label: '骨架', zmin: 0, zmax: 4 },
      { key: 'low', label: '低清', zmin: 5, zmax: 8 },
      { key: 'high', label: '高清', zmin: 9, zmax: 11 },
    ];

    /* ===== 本地缓存统计（懒加载：打开页面取一次；服务端 30s TTL + 回写即失效） ===== */
    let scan = null;
    fetch('/api/downloader/scan').then((r) => r.json()).then((s) => { scan = s; renderCache(); }).catch(() => {});
    const cacheChip = (s) => {
      if (s.id in localFirst && !localFirst[s.id]) return '<span class="chip off">未启用本地优先</span>';
      const d = scan && scan[s.scanKey];
      if (!d || !d.total) return '<span class="chip none">暂无本地缓存</span>';
      const levels = Object.keys(d.levels || {}).map(Number).sort((a, b) => a - b);
      const span = levels.length ? `（z${levels[0]}–z${levels[levels.length - 1]}）` : '';
      return `<span class="chip cache">已缓存 ${d.total.toLocaleString()} 张${span} · ${fmtSize(d.bytes)}</span>`;
    };
    const renderCache = () => {
      document.querySelectorAll('[data-cache]').forEach((el) => { el.innerHTML = cacheChip(JSON.parse(el.dataset.cache)); });
      let tiles = 0, bytes = 0;
      for (const k of ['esri', 'eox', 'gibs', 'tianditu']) {
        const d = scan && scan[k];
        if (d) { tiles += d.total; bytes += d.bytes; }
      }
      $('#total-tiles').textContent = tiles ? `${tiles.toLocaleString()} 张` : '0 张';
      $('#total-bytes').textContent = bytes ? fmtSize(bytes) : '0 B';
    };

    /* ===== 影像源列表 ===== */
    const layers = {};
    let baseId = 'tianditu';
    const listEl = $('#src-list');

    const buildRow = (s, idx) => {
      localFirst[s.id] = true;
      const row = document.createElement('div');
      row.className = 'src' + (s.id === baseId ? ' active' : '');
      row.draggable = true;
      row.dataset.id = s.id;
      const tierBtns = TIERS.map((t) => {
        const disabled = t.zmax > s.maxZ ? 'disabled' : '';
        const tip = t.zmax > s.maxZ ? `超出源最高层级 z${s.maxZ}` : estLabel(s, t.zmin, t.zmax);
        return `<button class="btn tier act-tier" data-tier="${t.key}" title="${tip}" ${disabled}>${t.label} z${t.zmin}–${t.zmax}</button>`;
      }).join('');
      row.innerHTML = `
        <div class="src-top">
          <span class="drag-handle" title="拖动调整优先级">⠿</span>
          <span class="src-name">${s.name}</span>
          <span class="live-dot" title="当前底图"></span>
          <span class="src-order ${idx === 0 ? '' : 'backup'}">P${idx + 1}</span>
        </div>
        <div class="chips">
          ${s.chips.map((c) => `<span class="chip">${c}</span>`).join('')}
          <span data-cache='${JSON.stringify(s)}'></span>
          <span class="chip est" title="按本地实测均瓦片大小（${s.avgKB} KB/张）推算">${estLabel(s, 0, Math.min(10, s.maxZ))}</span>
          <a class="chip" href="${s.doc}" target="_blank" rel="noopener" title="数据源官方文档（新窗口打开）">📖 ${s.docLabel} ↗</a>
        </div>
        <div class="src-ops">
          <button class="btn primary act-live" title="把该源设为首选底图（P1）">设为首选</button>
          <label class="show-cb" title="该源作为叠加层是否显示"><input type="checkbox" class="act-show" checked /> 显影</label>
          <label class="show-cb" title="请求走本地代理（有缓存直出、无缓存拉上游并落盘）；关闭则直连上游、不缓存"><input type="checkbox" class="act-local-first" checked /> 本地优先</label>
          <span style="flex:1"></span>
          <button class="btn icon act-up" title="提升优先级">▲</button>
          <button class="btn icon act-down" title="降低优先级">▼</button>
        </div>
        <div class="src-ops">
          ${tierBtns}
          <div class="prog"><i></i></div>
          <span class="prog-txt"></span>
        </div>`;
      row.querySelector('.act-live').addEventListener('click', (e) => { e.stopPropagation(); setBase(s.id); });
      row.querySelector('.act-show').addEventListener('change', (e) => { e.stopPropagation(); toggleShow(s.id, e.target.checked); });
      row.querySelector('.act-local-first').addEventListener('change', (e) => { e.stopPropagation(); setLocalFirst(s.id, e.target.checked); });
      row.querySelectorAll('.act-tier').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = TIERS.find((x) => x.key === b.dataset.tier);
        fakeDownload(row, s, t);
      }));
      row.querySelector('.act-up').addEventListener('click', (e) => { e.stopPropagation(); move(s.id, -1); });
      row.querySelector('.act-down').addEventListener('click', (e) => { e.stopPropagation(); move(s.id, +1); });
      return row;
    };

    const renderList = () => {
      listEl.innerHTML = '';
      SOURCES.forEach((s, i) => listEl.appendChild(buildRow(s, i)));
      bindDnD();
    };

    /* ===== 图层操作（真实 Cesium） ===== */
    const ensureLayer = (s) => {
      if (layers[s.id]) return layers[s.id];
      const layer = new Cesium.ImageryLayer(s.provider(), { show: true });
      viewer.imageryLayers.add(layer);
      layers[s.id] = layer;
      return layer;
    };
    const setBase = (id) => {
      const s = SOURCES.find((x) => x.id === id);
      if (!s) return;
      if (s.needsKey) { toast('Demo 不注入 key：真机版将从 .env / 输入框读取'); return; }
      baseId = id;
      if (layers[id]) { viewer.imageryLayers.remove(layers[id]); delete layers[id]; }
      ensureLayer(s);
      document.querySelectorAll('.src').forEach((r) => r.classList.toggle('active', r.dataset.id === id));
      toast(`${s.name} 已设为首选底图（P1）`);
    };
    const toggleShow = (id, on) => {
      const s = SOURCES.find((x) => x.id === id);
      if (!s) return;
      if (on) ensureLayer(s); else if (layers[id]) layers[id].show = false;
      if (layers[id]) layers[id].show = on;
    };
    const setLocalFirst = (id, on) => {
      localFirst[id] = on;
      const s = SOURCES.find((x) => x.id === id);
      const row = listEl.querySelector(`.src[data-id="${id}"] [data-cache]`);
      if (row) row.outerHTML = `<span data-cache='${JSON.stringify(s)}'></span>`;
      renderCache();
      toast(on
        ? `${s.name}：本地优先已开（有缓存直出 / 无缓存拉上游并落盘）`
        : `${s.name}：本地优先已关（直连上游，不写入本地缓存）`);
    };

    /* ===== 优先级移动（▲▼ + 拖拽共用） ===== */
    const move = (id, dir) => {
      const i = SOURCES.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= SOURCES.length) return;
      const [m] = SOURCES.splice(i, 1);
      SOURCES.splice(j, 0, m);
      renderList();
      toast(`优先级：${SOURCES.map((s) => s.name).join(' → ')}`);
    };

    /* ===== 分段下载（演示进度；真实实现调 /api/downloader/start） ===== */
    const fakeDownload = (row, s, tier) => {
      const prog = row.querySelector('.prog'), bar = row.querySelector('.prog > i'), txt = row.querySelector('.prog-txt');
      const btn = row.querySelector(`.act-tier[data-tier="${tier.key}"]`);
      if (!prog) return;
      btn.disabled = true; prog.classList.add('on');
      const total = countFor(s, tier.zmin, tier.zmax);
      let p = 0;
      const timer = setInterval(() => {
        p = Math.min(100, p + 3 + Math.random() * 6);
        bar.style.width = p + '%';
        txt.textContent = `${tier.label} z${tier.zmin}–${tier.zmax} · ${Math.round(p)}% · ${fmtN(Math.round(total * p / 100))} 张`;
        if (p >= 100) {
          clearInterval(timer);
          txt.textContent = `✓ ${tier.label}完成 · ${fmtN(total)} 张（含极冠补丁）`;
          setTimeout(() => { prog.classList.remove('on'); txt.textContent = ''; btn.disabled = false; }, 1800);
          toast(`${s.name} ${tier.label}段：演示完成（${estLabel(s, tier.zmin, tier.zmax)}）`);
        }
      }, 120);
    };

    /* ===== 拖拽排序 ===== */
    let dragIdx = null;
    const bindDnD = () => {
      listEl.querySelectorAll('.src').forEach((row, i) => {
        row.addEventListener('dragstart', () => { dragIdx = i; row.classList.add('dragging'); });
        row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragIdx = null; });
        row.addEventListener('dragover', (e) => e.preventDefault());
        row.addEventListener('drop', () => {
          if (dragIdx === null || dragIdx === i) return;
          const [moved] = SOURCES.splice(dragIdx, 1);
          SOURCES.splice(i, 0, moved);
          renderList();
          toast(`优先级：${SOURCES.map((s) => s.name).join(' → ')}`);
        });
      });
    };

    /* ===== 地形源（独立） ===== */
    const tRow = document.createElement('div');
    tRow.className = 'src';
    const tTierBtns = TIERS.map((t) => {
      const disabled = t.zmax > TERRAIN.maxZ ? 'disabled' : '';
      const tip = disabled ? `超出源最高层级 z${TERRAIN.maxZ}` : estLabel(TERRAIN, t.zmin, t.zmax);
      return `<button class="btn tier act-tier" data-tier="${t.key}" title="${tip}" ${disabled}>${t.label} z${t.zmin}–${t.zmax}</button>`;
    }).join('');
    tRow.innerHTML = `
      <div class="src-top">
        <span class="drag-handle" style="visibility:hidden">⠿</span>
        <span class="src-name">${TERRAIN.name}</span>
      </div>
      <div class="chips">${TERRAIN.chips.map((c) => `<span class="chip">${c}</span>`).join('')}
        <span data-cache='${JSON.stringify(TERRAIN)}'></span>
        <span class="chip est" title="按本地实测均瓦片大小（${TERRAIN.avgKB} KB/张）推算">${estLabel(TERRAIN, 0, 10)}</span>
        <a class="chip" href="${TERRAIN.doc}" target="_blank" rel="noopener">📖 ${TERRAIN.docLabel} ↗</a>
      </div>
      <div class="src-ops">
        <label class="show-cb" title="地形整体启用/停用"><input type="checkbox" class="t-show" /> 启用（整体）</label>
        <label class="show-cb" title="地形同样走本地优先代理"><input type="checkbox" class="act-local-first" checked /> 本地优先</label>
      </div>
      <div class="src-ops">
        ${tTierBtns}
        <div class="prog"><i></i></div>
        <span class="prog-txt"></span>
      </div>`;
    tRow.querySelector('.t-show').addEventListener('change', (e) => {
      toast(e.target.checked ? '地形已启用（真机版挂载 terrarium-provider）' : '地形已停用');
    });
    tRow.querySelectorAll('.act-tier').forEach((b) => b.addEventListener('click', () => {
      const t = TIERS.find((x) => x.key === b.dataset.tier);
      fakeDownload(tRow, TERRAIN, t);
    }));
    $('#terrain-list').appendChild(tRow);

    /* ===== 面板收起 ===== */
    const panel = $('#panel'), toggleBtn = $('#panel-toggle');
    toggleBtn.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      toggleBtn.textContent = panel.classList.contains('collapsed') ? '‹ 展开配置' : '收起配置 ›';
      setTimeout(() => viewer.resize(), 300);
    });

    renderList();
    ensureLayer(SOURCES[0]);
    setTimeout(() => { try { viewer.resize(); } catch { /* ignore */ } }, 300);
  