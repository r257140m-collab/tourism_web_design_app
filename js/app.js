/* ==========================================================================
   ZimTrails — application
   Hash-based single-page app: #/  #/explore  #/destination/:id  #/trip  #/admin
   ========================================================================== */

(() => {
  'use strict';

  /* ---------------------------------------------------------------------
     Constants & helpers
     --------------------------------------------------------------------- */
  const PROVINCES = ['Bulawayo', 'Harare', 'Manicaland', 'Mashonaland Central', 'Mashonaland East',
    'Mashonaland West', 'Masvingo', 'Matabeleland North', 'Matabeleland South', 'Midlands'];
  const CAT_COLORS = { 1: '#5f7f34', 2: '#9a5a2c', 3: '#2f6e8e', 4: '#5c5888', 5: '#2b857a', 6: '#7d6a50' };
  const ZIM_BOUNDS = [[-22.45, 25.2], [-15.6, 33.1]];
  const ADMIN_PIN = 'admin123';

  const app = document.getElementById('app');
  const modalRoot = document.getElementById('modalRoot');
  let activeMaps = [];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const money = n => (Number(n) > 0 ? '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }) : 'Free');
  const catColor = id => CAT_COLORS[id] || '#6b6f68';
  function stars(avg) {
    const r = Math.round(Number(avg) || 0);
    return '<span class="stars" aria-label="' + r + ' out of 5">' + '★'.repeat(r) + '<span style="color:var(--line-strong)">' + '★'.repeat(5 - r) + '</span></span>';
  }
  function initials(name) {
    return name.split(/\s+/).filter(w => /^[A-Z]/.test(w)).slice(0, 2).map(w => w[0]).join('');
  }
  function km(a, b) {
    const R = 6371, rad = x => x * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T') + (s.length > 10 ? 'Z' : ''));
    return isNaN(d) ? s : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, query = ''] = raw.split('?');
    return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query) };
  }

  /* ---------------------------------------------------------------------
     Modal
     --------------------------------------------------------------------- */
  function openModal({ title, body, footer = '', onMount }) {
    modalRoot.innerHTML = `
      <div class="modal-backdrop" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal">
          <header><h2>${esc(title)}</h2><button class="close-x" data-close aria-label="Close">&times;</button></header>
          <div class="content">${body}</div>
          ${footer ? `<footer>${footer}</footer>` : ''}
        </div>
      </div>`;
    const backdrop = $('.modal-backdrop', modalRoot);
    backdrop.addEventListener('click', e => { if (e.target === backdrop || e.target.closest('[data-close]')) closeModal(); });
    document.addEventListener('keydown', escClose);
    if (onMount) onMount($('.modal', modalRoot));
    const first = $('input, select, textarea', modalRoot);
    if (first) first.focus();
  }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    modalRoot.innerHTML = '';
    document.removeEventListener('keydown', escClose);
  }

  /* ---------------------------------------------------------------------
     Data access
     --------------------------------------------------------------------- */
  const BASE_SELECT = `
    SELECT d.*, c.name AS category,
      (SELECT ROUND(AVG(rating), 1) FROM reviews r WHERE r.destination_id = d.id) AS avg_rating,
      (SELECT COUNT(*) FROM reviews r WHERE r.destination_id = d.id) AS review_count,
      (SELECT MIN(price_usd) FROM activities a WHERE a.destination_id = d.id) AS from_price,
      (SELECT COUNT(*) FROM activities a WHERE a.destination_id = d.id) AS activity_count,
      EXISTS (SELECT 1 FROM trip_items t WHERE t.destination_id = d.id) AS in_trip
    FROM destinations d JOIN categories c ON c.id = d.category_id`;

  function queryDestinations({ q = '', cat = '', province = '', maxFee = '', sort = 'featured' } = {}) {
    const where = [], params = [];
    if (q) {
      where.push(`(d.name LIKE ? OR d.summary LIKE ? OR d.nearest_town LIKE ? OR d.province LIKE ?
        OR EXISTS (SELECT 1 FROM activities a WHERE a.destination_id = d.id AND a.name LIKE ?))`);
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
    if (cat) { where.push('d.category_id = ?'); params.push(Number(cat)); }
    if (province) { where.push('d.province = ?'); params.push(province); }
    if (maxFee !== '') { where.push('d.entry_fee_usd <= ?'); params.push(Number(maxFee)); }
    const order = {
      featured: 'd.featured DESC, avg_rating DESC, d.name',
      rating: 'avg_rating IS NULL, avg_rating DESC, review_count DESC',
      name: 'd.name COLLATE NOCASE',
      fee: 'd.entry_fee_usd, d.name',
    }[sort] || 'd.name';
    return DB.all(`${BASE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`, params);
  }

  const getDestination = id => DB.one(`${BASE_SELECT} WHERE d.id = ?`, [Number(id)]);
  const getCategories = () => DB.all(`SELECT c.*, (SELECT COUNT(*) FROM destinations d WHERE d.category_id = c.id) AS n FROM categories c ORDER BY c.id`);

  function updateTripCount() {
    $('#tripCount').textContent = DB.one('SELECT COUNT(*) AS n FROM trip_items').n;
  }
  function toggleTrip(destId) {
    const existing = DB.one('SELECT id FROM trip_items WHERE destination_id = ?', [destId]);
    if (existing) {
      DB.run('DELETE FROM trip_items WHERE destination_id = ?', [destId]);
      normaliseTripOrder();
      toast('Removed from your trip');
    } else {
      const pos = DB.one('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM trip_items').p;
      DB.run('INSERT INTO trip_items (destination_id, position, nights) VALUES (?, ?, 1)', [destId, pos]);
      toast('Added to your trip');
    }
    updateTripCount();
    return !existing;
  }
  function normaliseTripOrder() {
    DB.all('SELECT id FROM trip_items ORDER BY position').forEach((r, i) =>
      DB.run('UPDATE trip_items SET position = ? WHERE id = ?', [i + 1, r.id]));
  }

  /* ---------------------------------------------------------------------
     Maps (Leaflet + OpenStreetMap tiles)
     --------------------------------------------------------------------- */
  /* Base map tiles. OpenStreetMap's own tile servers block pages opened
     straight from the file system (they send no Referer header), and CARTO
     now requires an API key in that case. Esri's World Topo basemap works
     without a key or a web server, and labels national parks clearly. */
  function addTiles(map) {
    return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 18,
      attribution: 'Tiles &copy; <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> &middot; Data: Esri, HERE, Garmin, USGS, OpenStreetMap',
    }).addTo(map);
  }

  function createMap(el, { interactive = true } = {}) {
    const map = L.map(el, {
      scrollWheelZoom: interactive, zoomControl: interactive, dragging: interactive || !L.Browser.mobile,
      attributionControl: true,
    });
    map.fitBounds(ZIM_BOUNDS);
    const tiles = addTiles(map);
    let warned = false;
    tiles.on('tileerror', () => {
      if (warned) return;
      warned = true;
      const note = document.createElement('div');
      note.className = 'map-offline';
      note.textContent = 'Map tiles need an internet connection. Destination markers are still shown.';
      el.appendChild(note);
    });
    activeMaps.push(map);
    return map;
  }
  function marker(d, opts = {}) {
    return L.circleMarker([d.lat, d.lng], {
      radius: opts.radius || 7, color: '#fff', weight: 2, fillColor: catColor(d.category_id), fillOpacity: 1,
    });
  }
  function popupHtml(d) {
    return `<h4>${esc(d.name)}</h4><div class="muted">${esc(d.category)} &middot; ${esc(d.province)}</div>
      <div style="margin-top:6px"><a href="#/destination/${d.id}">View details &rarr;</a></div>`;
  }
  function destroyMaps() {
    activeMaps.forEach(m => m.remove());
    activeMaps = [];
  }

  /* ---------------------------------------------------------------------
     Shared fragments
     --------------------------------------------------------------------- */
  function destCard(d) {
    const thumb = d.image_url
      ? `<img src="${esc(d.image_url)}" alt="${esc(d.name)}" loading="lazy">`
      : `<div class="thumb-fallback" style="background:${catColor(d.category_id)}">
           <div class="initials">${esc(initials(d.name))}</div>
           <div class="coords">${Math.abs(d.lat).toFixed(2)}&deg;S ${d.lng.toFixed(2)}&deg;E</div>
         </div>`;
    return `
      <a class="card dest-card" href="#/destination/${d.id}">
        <div class="thumb">${thumb}</div>
        <div class="body">
          <div class="meta"><span class="dot" style="background:${catColor(d.category_id)}"></span>${esc(d.category)} &middot; ${esc(d.province)}</div>
          <h3>${esc(d.name)}</h3>
          <p>${esc(d.summary)}</p>
          <div class="foot">
            <span>${d.review_count ? `${stars(d.avg_rating)} ${d.avg_rating}` : 'No reviews yet'}</span>
            <span>Entry <strong>${money(d.entry_fee_usd)}</strong></span>
          </div>
        </div>
      </a>`;
  }
  function categoryOptions(selected) {
    return getCategories().map(c => `<option value="${c.id}" ${String(selected) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  }
  function provinceOptions(selected) {
    return PROVINCES.map(p => `<option ${p === selected ? 'selected' : ''}>${esc(p)}</option>`).join('');
  }

  /* ---------------------------------------------------------------------
     View: Home
     --------------------------------------------------------------------- */
  function viewHome() {
    const all = queryDestinations();
    const featured = all.filter(d => d.featured).slice(0, 6);
    const cats = getCategories();
    const stats = DB.one(`SELECT (SELECT COUNT(*) FROM destinations) AS d, (SELECT COUNT(*) FROM activities) AS a,
      (SELECT COUNT(DISTINCT province) FROM destinations) AS p`);

    app.innerHTML = `
      <section class="hero">
        <div class="wrap hero-grid">
          <div>
            <div class="eyebrow">Discover Zimbabwe</div>
            <h1>There is more to Zimbabwe than one waterfall.</h1>
            <p class="lead">Find national parks, heritage sites, mountains and lakes across all ten provinces. Check fees, compare activities, plan a route and contact providers in one place.</p>
            <form class="search-bar" id="homeSearch">
              <input type="search" name="q" placeholder="Search a place, town or activity, e.g. rafting" aria-label="Search">
              <button class="btn btn-primary">Search</button>
            </form>
            <div class="small muted">Popular: <a href="#/explore?q=safari">safari</a> &middot; <a href="#/explore?q=hiking">hiking</a> &middot; <a href="#/explore?cat=2">heritage sites</a> &middot; <a href="#/explore?province=Manicaland">Eastern Highlands</a></div>
            <div class="hero-stats">
              <div><strong>${stats.d}</strong>destinations</div>
              <div><strong>${stats.a}</strong>bookable activities</div>
              <div><strong>${stats.p}</strong>provinces covered</div>
            </div>
          </div>
          <div class="hero-map" id="heroMap"></div>
        </div>
      </section>

      <section class="section">
        <div class="wrap">
          <div class="section-head"><h2>Browse by interest</h2></div>
          <div class="cat-grid">
            ${cats.map(c => `
              <a class="cat-item" href="#/explore?cat=${c.id}">
                <span class="swatch" style="background:${catColor(c.id)}"></span>
                <div><h3>${esc(c.name)}</h3><p>${esc(c.blurb || '')}</p></div>
                <span class="n">${c.n}</span>
              </a>`).join('')}
          </div>
        </div>
      </section>

      <section class="section" style="padding-top:0">
        <div class="wrap">
          <div class="section-head"><h2>Featured destinations</h2><a href="#/explore">View all on the map &rarr;</a></div>
          <div class="grid">${featured.map(destCard).join('')}</div>
        </div>
      </section>

      <section class="section" style="background:var(--surface);border-top:1px solid var(--line)">
        <div class="wrap">
          <div class="eyebrow">Why ZimTrails</div>
          <h2 style="margin-bottom:24px">Tourism information in Zimbabwe is scattered. We put it in one place.</h2>
          <div class="problem-strip">
            <div><div class="num">01</div><h3>One trusted directory</h3><p>Fees, seasons, directions and activities that are usually spread across social media pages, PDFs and word of mouth.</p></div>
            <div><div class="num">02</div><h3>Beyond the big names</h3><p>Lesser-known sites like Khami, Chimanimani and Gonarezhou sit on the same map as Victoria Falls and Hwange.</p></div>
            <div><div class="num">03</div><h3>Direct to local providers</h3><p>Visitors send enquiries straight to guides and operators, who manage them from the operator portal.</p></div>
          </div>
        </div>
      </section>`;

    $('#homeSearch').addEventListener('submit', e => {
      e.preventDefault();
      const q = new FormData(e.target).get('q').trim();
      location.hash = '#/explore' + (q ? '?q=' + encodeURIComponent(q) : '');
    });

    const map = createMap($('#heroMap'), { interactive: true });
    map.scrollWheelZoom.disable();
    all.forEach(d => marker(d).bindPopup(popupHtml(d)).addTo(map));
  }

  /* ---------------------------------------------------------------------
     View: Explore (list + map)
     --------------------------------------------------------------------- */
  function viewExplore(params) {
    const f = {
      q: params.get('q') || '', cat: params.get('cat') || '', province: params.get('province') || '',
      maxFee: params.get('maxFee') || '', sort: params.get('sort') || 'featured',
    };
    const cats = getCategories();

    app.innerHTML = `
      <div class="explore">
        <aside class="explore-side">
          <div class="filters">
            <input type="search" id="fq" placeholder="Search destinations or activities" value="${esc(f.q)}" aria-label="Search">
            <div class="row">
              <select id="fcat" aria-label="Category"><option value="">All categories</option>${categoryOptions(f.cat)}</select>
              <select id="fprov" aria-label="Province"><option value="">All provinces</option>${provinceOptions(f.province)}</select>
            </div>
            <div class="row">
              <select id="ffee" aria-label="Maximum entry fee">
                <option value="">Any entry fee</option>
                ${[0, 10, 15, 20].map(v => `<option value="${v}" ${f.maxFee === String(v) ? 'selected' : ''}>${v === 0 ? 'Free entry only' : 'Up to $' + v}</option>`).join('')}
              </select>
              <select id="fsort" aria-label="Sort">
                ${[['featured', 'Sort: Recommended'], ['rating', 'Sort: Highest rated'], ['name', 'Sort: Name A–Z'], ['fee', 'Sort: Lowest fee']]
                  .map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="result-count"><span id="countLabel"></span><a href="#/explore" id="clearF">Clear filters</a></div>
          <div class="result-list" id="results"></div>
        </aside>
        <div class="explore-map">
          <div id="map"></div>
          <div class="legend">${cats.map(c => `<div><span class="dot" style="background:${catColor(c.id)}"></span>${esc(c.name)}</div>`).join('')}</div>
        </div>
      </div>`;

    const map = createMap($('#map'));
    const layer = L.layerGroup().addTo(map);
    const markers = {};

    function render() {
      const rows = queryDestinations(f);
      $('#countLabel').textContent = `${rows.length} destination${rows.length === 1 ? '' : 's'}`;
      $('#results').innerHTML = rows.length ? rows.map(d => `
        <div class="list-item" data-id="${d.id}" tabindex="0" role="link">
          <span class="bar" style="background:${catColor(d.category_id)}"></span>
          <div>
            <h3>${esc(d.name)}</h3>
            <p>${esc(d.category)} &middot; ${esc(d.nearest_town || d.province)}</p>
            <p style="margin-top:4px">${d.review_count ? stars(d.avg_rating) + ` <span>${d.review_count} review${d.review_count > 1 ? 's' : ''}</span>` : '<span>No reviews yet</span>'}</p>
          </div>
          <div class="right"><strong>${money(d.entry_fee_usd)}</strong>entry<br>${d.activity_count} activit${d.activity_count === 1 ? 'y' : 'ies'}</div>
        </div>`).join('') : '<div class="empty">No destinations match these filters.</div>';

      layer.clearLayers();
      rows.forEach(d => { markers[d.id] = marker(d).bindPopup(popupHtml(d)).addTo(layer); });
      if (rows.length) {
        const b = L.latLngBounds(rows.map(d => [d.lat, d.lng]));
        rows.length === 1 ? map.setView(b.getCenter(), 9) : map.fitBounds(b.pad(0.15), { maxZoom: 9 });
      } else {
        map.fitBounds(ZIM_BOUNDS);
      }
    }

    function syncHash() {
      const p = new URLSearchParams();
      Object.entries(f).forEach(([k, v]) => { if (v !== '' && !(k === 'sort' && v === 'featured')) p.set(k, v); });
      history.replaceState(null, '', '#/explore' + (p.toString() ? '?' + p : ''));
    }

    let t;
    $('#fq').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); syncHash(); render(); }, 200); });
    [['#fcat', 'cat'], ['#fprov', 'province'], ['#ffee', 'maxFee'], ['#fsort', 'sort']].forEach(([sel, key]) =>
      $(sel).addEventListener('change', e => { f[key] = e.target.value; syncHash(); render(); }));

    const results = $('#results');
    results.addEventListener('click', e => {
      const item = e.target.closest('.list-item');
      if (item) location.hash = '#/destination/' + item.dataset.id;
    });
    results.addEventListener('keydown', e => {
      const item = e.target.closest('.list-item');
      if (item && e.key === 'Enter') location.hash = '#/destination/' + item.dataset.id;
    });
    results.addEventListener('mouseover', e => {
      const item = e.target.closest('.list-item');
      Object.values(markers).forEach(m => m.setRadius(7));
      if (item && markers[item.dataset.id]) markers[item.dataset.id].setRadius(12).bringToFront();
    });

    render();
  }

  /* ---------------------------------------------------------------------
     View: Destination detail
     --------------------------------------------------------------------- */
  function viewDestination(id) {
    destroyMaps();
    const d = getDestination(id);
    if (!d) {
      app.innerHTML = `<div class="wrap section"><div class="empty">This destination could not be found. <a href="#/explore">Back to explore</a></div></div>`;
      return;
    }
    const acts = DB.all('SELECT * FROM activities WHERE destination_id = ? ORDER BY price_usd', [d.id]);
    const reviews = DB.all('SELECT * FROM reviews WHERE destination_id = ? ORDER BY created_at DESC', [d.id]);
    const nearby = DB.all('SELECT d.id, d.name, d.lat, d.lng, c.name AS category FROM destinations d JOIN categories c ON c.id = d.category_id WHERE d.id != ?', [d.id])
      .map(n => ({ ...n, dist: km(d, n) })).sort((a, b) => a.dist - b.dist).slice(0, 4);

    app.innerHTML = `
      <div class="detail-head">
        <div class="wrap">
          <div class="crumbs"><a href="#/">Home</a> / <a href="#/explore">Explore</a> / <a href="#/explore?province=${encodeURIComponent(d.province)}">${esc(d.province)}</a></div>
          <div class="title-row">
            <div>
              <span class="tag"><span class="dot" style="background:${catColor(d.category_id)}"></span>${esc(d.category)}</span>
              <h1>${esc(d.name)}</h1>
              <div class="sub">
                <span>${esc(d.nearest_town && d.nearest_town !== d.province ? d.nearest_town + ', ' + d.province + ' Province' : d.province + ' Province')}</span>
                <span>${d.review_count ? `${stars(d.avg_rating)} ${d.avg_rating} (${d.review_count})` : 'No reviews yet'}</span>
              </div>
            </div>
            <div class="actions">
              <button class="btn" id="tripBtn">${d.in_trip ? 'Remove from trip' : 'Add to trip'}</button>
              <button class="btn btn-primary" id="enquireBtn">Send enquiry</button>
            </div>
          </div>
          ${d.image_url ? `<div class="detail-hero-img"><img src="${esc(d.image_url)}" alt="${esc(d.name)}"></div>` : ''}
        </div>
      </div>

      <div class="wrap detail-grid">
        <div>
          <section>
            <h2>Overview</h2>
            <p class="prose" style="font-size:16px;color:var(--ink)">${esc(d.summary)}</p>
            <p class="prose">${esc(d.description || '')}</p>
          </section>

          <section>
            <h2>Activities</h2>
            ${acts.length ? `
              <div class="table-wrap"><table>
                <thead><tr><th>Activity</th><th>Duration</th><th class="num">From</th><th></th></tr></thead>
                <tbody>${acts.map(a => `
                  <tr>
                    <td><strong>${esc(a.name)}</strong><div class="small">${esc(a.provider || '')}${a.notes ? ' &middot; ' + esc(a.notes) : ''}</div></td>
                    <td>${esc(a.duration || '—')}</td>
                    <td class="num">${money(a.price_usd)}</td>
                    <td class="num"><button class="btn btn-sm" data-enquire="${a.id}">Enquire</button></td>
                  </tr>`).join('')}
                </tbody>
              </table></div>` : '<div class="empty">No activities listed yet.</div>'}
          </section>

          <section>
            <h2>Getting there</h2>
            <p class="prose">${esc(d.access_info || 'Directions not yet provided.')}</p>
          </section>

          <section>
            <h2>Reviews</h2>
            <div class="panel">
              ${reviews.length ? reviews.map(r => `
                <div class="review">
                  <div class="who"><strong>${esc(r.author)}</strong><span>${stars(r.rating)} &nbsp;${fmtDate(r.created_at)}</span></div>
                  <p>${esc(r.comment || '')}</p>
                </div>`).join('') : '<p class="muted" style="margin:0">Be the first to review this destination.</p>'}
            </div>
            <form class="panel" id="reviewForm" style="margin-top:12px">
              <h3>Write a review</h3>
              <div class="row">
                <div class="field"><label for="rvName">Your name</label><input id="rvName" name="author" required maxlength="60"></div>
                <div class="field"><label>Rating</label><div class="rating-input" id="rvStars">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-v="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div></div>
              </div>
              <div class="field"><label for="rvText">Your experience</label><textarea id="rvText" name="comment" maxlength="800" placeholder="What should other visitors know?"></textarea></div>
              <button class="btn btn-primary">Post review</button>
            </form>
          </section>
        </div>

        <aside class="side-stack">
          <div class="card facts">
            <div class="mini-map" id="miniMap"></div>
            <dl>
              <dt>Entry fee (international adult)</dt><dd><strong>${money(d.entry_fee_usd)}</strong>${d.fee_note ? `<div class="small muted">${esc(d.fee_note)}</div>` : ''}</dd>
              <dt>Best time to visit</dt><dd>${esc(d.best_time || '—')}</dd>
              <dt>Nearest town</dt><dd>${esc(d.nearest_town || '—')}</dd>
              <dt>Coordinates</dt><dd style="font-family:var(--mono);font-size:13px">${d.lat.toFixed(4)}, ${d.lng.toFixed(4)}
                &nbsp;<a href="https://www.openstreetmap.org/directions?to=${d.lat}%2C${d.lng}" target="_blank" rel="noopener">Directions</a></dd>
            </dl>
          </div>
          <div class="panel nearby">
            <h3>Nearby</h3>
            ${nearby.map(n => `<a href="#/destination/${n.id}">${esc(n.name)}<span>${Math.round(n.dist)} km</span></a>`).join('')}
          </div>
        </aside>
      </div>`;

    const map = createMap($('#miniMap'), { interactive: false });
    map.setView([d.lat, d.lng], 8);
    marker(d, { radius: 9 }).addTo(map);

    $('#tripBtn').addEventListener('click', e => {
      const added = toggleTrip(d.id);
      e.target.textContent = added ? 'Remove from trip' : 'Add to trip';
    });
    $('#enquireBtn').addEventListener('click', () => enquiryModal(d, acts));
    $$('[data-enquire]').forEach(b => b.addEventListener('click', () => enquiryModal(d, acts, Number(b.dataset.enquire))));

    let rating = 0;
    const starBtns = $$('#rvStars button');
    starBtns.forEach(b => b.addEventListener('click', () => {
      rating = Number(b.dataset.v);
      starBtns.forEach(s => s.classList.toggle('on', Number(s.dataset.v) <= rating));
    }));
    $('#reviewForm').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const author = fd.get('author').trim();
      if (!author) return toast('Please enter your name');
      if (!rating) return toast('Please choose a star rating');
      DB.run('INSERT INTO reviews (destination_id, author, rating, comment) VALUES (?, ?, ?, ?)', [d.id, author, rating, fd.get('comment').trim()]);
      toast('Thank you, your review has been posted');
      viewDestination(d.id);
    });
  }

  function enquiryModal(d, acts, activityId = null) {
    const today = new Date().toISOString().slice(0, 10);
    openModal({
      title: 'Send an enquiry',
      body: `
        <p class="muted small" style="margin-top:-4px">${esc(d.name)} &middot; Your details go directly to the provider.</p>
        <form id="enqForm" novalidate>
          <div class="field"><label for="eqAct">Activity</label>
            <select id="eqAct" name="activity_id"><option value="">General enquiry</option>
              ${acts.map(a => `<option value="${a.id}" ${a.id === activityId ? 'selected' : ''}>${esc(a.name)} (${money(a.price_usd)})</option>`).join('')}
            </select></div>
          <div class="row">
            <div class="field"><label for="eqName">Full name *</label><input id="eqName" name="full_name" required maxlength="80"></div>
            <div class="field"><label for="eqEmail">Email *</label><input id="eqEmail" name="email" type="email" required maxlength="120"></div>
          </div>
          <div class="row">
            <div class="field"><label for="eqPhone">Phone / WhatsApp</label><input id="eqPhone" name="phone" maxlength="30" placeholder="+263 ..."></div>
            <div class="field"><label for="eqDate">Travel date</label><input id="eqDate" name="travel_date" type="date" min="${today}"></div>
          </div>
          <div class="field" style="max-width:160px"><label for="eqSize">Group size</label><input id="eqSize" name="group_size" type="number" min="1" max="50" value="2"></div>
          <div class="field"><label for="eqMsg">Message</label><textarea id="eqMsg" name="message" maxlength="1000" placeholder="Questions, dietary needs, pick-up location..."></textarea></div>
          <div id="eqErr" class="small" style="color:var(--danger)"></div>
        </form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="eqSend">Send enquiry</button>`,
      onMount: m => {
        $('#eqSend', m).addEventListener('click', () => {
          const fd = new FormData($('#enqForm', m));
          const v = k => (fd.get(k) || '').toString().trim();
          const err = [];
          if (!v('full_name')) err.push('Enter your full name.');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email'))) err.push('Enter a valid email address.');
          const size = Number(v('group_size') || 1);
          if (!(size >= 1 && size <= 50)) err.push('Group size must be between 1 and 50.');
          if (v('travel_date') && v('travel_date') < today) err.push('Travel date cannot be in the past.');
          if (err.length) { $('#eqErr', m).textContent = err.join(' '); return; }

          const ref = 'ZT-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
          DB.run(`INSERT INTO enquiries (reference, destination_id, activity_id, full_name, email, phone, travel_date, group_size, message)
            VALUES (?,?,?,?,?,?,?,?,?)`,
            [ref, d.id, v('activity_id') ? Number(v('activity_id')) : null, v('full_name'), v('email'), v('phone'), v('travel_date'), size, v('message')]);
          openModal({
            title: 'Enquiry sent',
            body: `<p>Thank you, ${esc(v('full_name'))}. Your enquiry about <strong>${esc(d.name)}</strong> has been sent.</p>
              <p>Your reference number is</p>
              <p style="font:600 22px var(--mono);letter-spacing:.04em">${ref}</p>
              <p class="muted small" style="margin:0">Keep this number when you contact the provider.</p>`,
            footer: `<button class="btn btn-primary" data-close>Done</button>`,
          });
        });
      },
    });
  }

  /* ---------------------------------------------------------------------
     View: Trip planner
     --------------------------------------------------------------------- */
  function viewTrip() {
    destroyMaps();
    const items = DB.all(`SELECT t.id AS trip_id, t.position, t.nights, t.notes, d.id, d.name, d.lat, d.lng, d.province,
        d.entry_fee_usd, d.category_id, c.name AS category
      FROM trip_items t JOIN destinations d ON d.id = t.destination_id JOIN categories c ON c.id = d.category_id
      ORDER BY t.position`);

    let distance = 0;
    const legs = items.map((it, i) => (i ? km(items[i - 1], it) : 0));
    legs.forEach(l => { distance += l; });
    const nights = items.reduce((s, it) => s + (Number(it.nights) || 0), 0);
    const fees = items.reduce((s, it) => s + it.entry_fee_usd * Math.max(1, Number(it.nights) || 0), 0);

    app.innerHTML = `
      <div class="wrap">
        <div class="page-head">
          <h1>My trip</h1>
          <p>Add destinations from any page, then put them in order. The planner shows your route, the distance between stops and an estimate of park entry fees.</p>
        </div>
        ${items.length ? `
        <div class="trip-grid">
          <div>
            <div class="card">
              ${items.map((it, i) => `
                ${i ? `<div class="leg">↓ approx. ${Math.round(legs[i])} km (straight line)</div>` : ''}
                <div class="trip-item" data-trip="${it.trip_id}">
                  <div class="step">${i + 1}</div>
                  <div>
                    <h3><a href="#/destination/${it.id}">${esc(it.name)}</a></h3>
                    <div class="small muted">${esc(it.category)} &middot; ${esc(it.province)} &middot; Entry ${money(it.entry_fee_usd)}</div>
                    <div class="inline">
                      <label style="margin:0;font-weight:500" for="n${it.trip_id}">Nights</label>
                      <input id="n${it.trip_id}" type="number" min="0" max="30" value="${it.nights}" data-field="nights">
                      <input class="note" type="text" placeholder="Add a note (e.g. book lodge)" value="${esc(it.notes || '')}" data-field="notes" maxlength="120" aria-label="Note">
                    </div>
                  </div>
                  <div class="controls">
                    <button class="btn btn-sm" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
                    <button class="btn btn-sm" data-move="1" ${i === items.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
                    <button class="btn btn-sm btn-danger" data-remove="${it.id}" aria-label="Remove">✕</button>
                  </div>
                </div>`).join('')}
              <div class="summary-grid">
                <div><strong>${items.length}</strong>stops</div>
                <div><strong>${Math.round(distance).toLocaleString()} km</strong>straight-line distance</div>
                <div><strong>${money(fees)}</strong>entry fees per person (est.)</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
              <a class="btn" href="#/explore">Add more destinations</a>
              <button class="btn" id="printTrip">Print itinerary</button>
              <button class="btn btn-ghost btn-danger" id="clearTrip">Clear trip</button>
            </div>
            <p class="small muted" style="margin-top:14px">${nights} night${nights === 1 ? '' : 's'} planned. Road distances are usually 20–40% longer than straight-line distances.</p>
          </div>
          <div class="trip-map" id="tripMap"></div>
        </div>` : `
        <div class="empty" style="margin-bottom:56px">
          <p>Your trip is empty.</p>
          <a class="btn btn-primary" href="#/explore">Explore destinations</a>
        </div>`}
      </div>`;

    if (!items.length) return;

    const map = createMap($('#tripMap'));
    const pts = items.map(it => [it.lat, it.lng]);
    L.polyline(pts, { color: '#1f4a34', weight: 3, dashArray: '6 6' }).addTo(map);
    items.forEach((it, i) => {
      L.marker([it.lat, it.lng], {
        icon: L.divIcon({
          className: '', iconSize: [26, 26], iconAnchor: [13, 13],
          html: `<div style="width:26px;height:26px;border-radius:50%;background:#1f4a34;color:#fff;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font:600 12px Inter,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.3)">${i + 1}</div>`,
        }),
      }).bindPopup(popupHtml(it)).addTo(map);
    });
    pts.length > 1 ? map.fitBounds(L.latLngBounds(pts).pad(0.2)) : map.setView(pts[0], 8);

    $$('.trip-item').forEach(row => {
      const tid = Number(row.dataset.trip);
      $$('[data-field]', row).forEach(inp => inp.addEventListener('change', () => {
        const field = inp.dataset.field;
        const val = field === 'nights' ? Math.max(0, Math.min(30, Number(inp.value) || 0)) : inp.value.trim();
        DB.run(`UPDATE trip_items SET ${field === 'nights' ? 'nights' : 'notes'} = ? WHERE id = ?`, [val, tid]);
        if (field === 'nights') viewTrip();
      }));
      $$('[data-move]', row).forEach(b => b.addEventListener('click', () => {
        const idx = items.findIndex(it => it.trip_id === tid);
        const other = items[idx + Number(b.dataset.move)];
        if (!other) return;
        DB.run('UPDATE trip_items SET position = ? WHERE id = ?', [other.position, tid]);
        DB.run('UPDATE trip_items SET position = ? WHERE id = ?', [items[idx].position, other.trip_id]);
        viewTrip();
      }));
    });
    $$('[data-remove]').forEach(b => b.addEventListener('click', () => { toggleTrip(Number(b.dataset.remove)); destroyMaps(); viewTrip(); }));
    $('#clearTrip').addEventListener('click', () => {
      if (!confirm('Remove all destinations from your trip?')) return;
      DB.run('DELETE FROM trip_items');
      updateTripCount();
      destroyMaps();
      viewTrip();
    });
    $('#printTrip').addEventListener('click', () => window.print());
  }

  /* ---------------------------------------------------------------------
     View: Operator portal (admin)
     --------------------------------------------------------------------- */
  const isAuthed = () => { try { return sessionStorage.getItem('zt.admin') === '1'; } catch (e) { return window.__ztAdmin === true; } };
  const setAuthed = v => { try { v ? sessionStorage.setItem('zt.admin', '1') : sessionStorage.removeItem('zt.admin'); } catch (e) { window.__ztAdmin = v; } };

  function viewAdmin(params) {
    if (!isAuthed()) {
      app.innerHTML = `
        <div class="wrap">
          <form class="panel login-box" id="loginForm">
            <h2>Operator portal</h2>
            <p class="muted small">For tourism operators and site administrators. Manage listings, activities and visitor enquiries.</p>
            <div class="field"><label for="pin">Access code</label><input id="pin" type="password" autocomplete="current-password" required></div>
            <div id="loginErr" class="small" style="color:var(--danger);margin-bottom:10px"></div>
            <button class="btn btn-primary" style="width:100%">Sign in</button>
            <p class="small muted" style="margin:14px 0 0">Demo access code: <code>${ADMIN_PIN}</code></p>
          </form>
        </div>`;
      $('#loginForm').addEventListener('submit', e => {
        e.preventDefault();
        if ($('#pin').value === ADMIN_PIN) { setAuthed(true); viewAdmin(params); }
        else $('#loginErr').textContent = 'Incorrect access code.';
      });
      return;
    }

    const tab = params.get('tab') || 'overview';
    const tabs = [['overview', 'Overview'], ['destinations', 'Destinations'], ['activities', 'Activities'], ['enquiries', 'Enquiries'], ['reviews', 'Reviews'], ['database', 'Database']];
    const newCount = DB.one("SELECT COUNT(*) AS n FROM enquiries WHERE status = 'New'").n;

    app.innerHTML = `
      <div class="wrap">
        <div class="page-head admin-bar" style="padding-bottom:0">
          <h1 style="margin:0">Operator portal</h1>
          <button class="btn btn-sm" id="logout">Sign out</button>
        </div>
        <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}${k === 'enquiries' && newCount ? ` (${newCount})` : ''}</button>`).join('')}</div>
        <div id="adminBody" style="padding-bottom:56px"></div>
      </div>`;

    $$('.tabs button').forEach(b => b.addEventListener('click', () => { location.hash = '#/admin?tab=' + b.dataset.tab; }));
    $('#logout').addEventListener('click', () => { setAuthed(false); viewAdmin(params); });

    const body = $('#adminBody');
    ({ overview: adminOverview, destinations: adminDestinations, activities: adminActivities, enquiries: adminEnquiries, reviews: adminReviews, database: adminDatabase }[tab] || adminOverview)(body, params);
  }

  function adminOverview(body) {
    const s = DB.one(`SELECT (SELECT COUNT(*) FROM destinations) AS dest, (SELECT COUNT(*) FROM activities) AS act,
      (SELECT COUNT(*) FROM enquiries) AS enq, (SELECT COUNT(*) FROM enquiries WHERE status='New') AS enq_new,
      (SELECT COUNT(*) FROM reviews) AS rev, (SELECT ROUND(AVG(rating),2) FROM reviews) AS avg`);
    const top = DB.all(`SELECT d.name, COUNT(e.id) AS n FROM destinations d LEFT JOIN enquiries e ON e.destination_id = d.id
      GROUP BY d.id ORDER BY n DESC, d.name LIMIT 5`);
    const recent = DB.all(`SELECT e.reference, e.full_name, e.status, e.created_at, d.name AS dest FROM enquiries e
      JOIN destinations d ON d.id = e.destination_id ORDER BY e.created_at DESC LIMIT 5`);
    body.innerHTML = `
      <div class="card" style="margin-bottom:20px"><div class="summary-grid" style="grid-template-columns:repeat(5,1fr);border-top:0;border-radius:var(--radius-lg);overflow:hidden">
        <div><strong>${s.dest}</strong>destinations</div><div><strong>${s.act}</strong>activities</div>
        <div><strong>${s.enq}</strong>enquiries</div><div><strong>${s.enq_new}</strong>awaiting reply</div>
        <div><strong>${s.avg ?? '—'}</strong>average rating (${s.rev})</div>
      </div></div>
      <div class="trip-grid" style="padding:0">
        <div><h3>Most enquired destinations</h3><div class="table-wrap"><table>
          <thead><tr><th>Destination</th><th class="num">Enquiries</th></tr></thead>
          <tbody>${top.map(t => `<tr><td>${esc(t.name)}</td><td class="num">${t.n}</td></tr>`).join('')}</tbody></table></div></div>
        <div><h3>Latest enquiries</h3>${recent.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Reference</th><th>Visitor</th><th>Status</th></tr></thead>
          <tbody>${recent.map(r => `<tr><td style="font-family:var(--mono);font-size:13px">${esc(r.reference)}<div class="small">${esc(r.dest)}</div></td><td>${esc(r.full_name)}</td><td><span class="status status-${esc(r.status)}">${esc(r.status)}</span></td></tr>`).join('')}</tbody>
          </table></div>` : '<div class="empty">No enquiries yet. They appear here when visitors use “Send enquiry”.</div>'}</div>
      </div>`;
    body.querySelector('.summary-grid').style.gridTemplateColumns = window.innerWidth < 700 ? 'repeat(2,1fr)' : 'repeat(5,1fr)';
  }

  function adminDestinations(body) {
    const rows = DB.all(`SELECT d.id, d.name, d.province, d.entry_fee_usd, d.featured, c.name AS category,
      (SELECT COUNT(*) FROM activities a WHERE a.destination_id = d.id) AS acts
      FROM destinations d JOIN categories c ON c.id = d.category_id ORDER BY d.name`);
    body.innerHTML = `
      <div class="admin-bar"><span class="muted">${rows.length} destinations</span><button class="btn btn-primary" id="addDest">Add destination</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Category</th><th>Province</th><th class="num">Fee</th><th class="num">Activities</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td><a href="#/destination/${r.id}">${esc(r.name)}</a>${r.featured ? ' <span class="tag">Featured</span>' : ''}</td>
          <td>${esc(r.category)}</td><td>${esc(r.province)}</td><td class="num">${money(r.entry_fee_usd)}</td><td class="num">${r.acts}</td>
          <td class="num"><button class="btn btn-sm" data-edit="${r.id}">Edit</button> <button class="btn btn-sm btn-danger" data-del="${r.id}">Delete</button></td>
        </tr>`).join('')}</tbody></table></div>`;

    $('#addDest').addEventListener('click', () => destinationForm(null, () => adminDestinations(body)));
    $$('[data-edit]', body).forEach(b => b.addEventListener('click', () => destinationForm(Number(b.dataset.edit), () => adminDestinations(body))));
    $$('[data-del]', body).forEach(b => b.addEventListener('click', () => {
      const d = DB.one('SELECT name FROM destinations WHERE id = ?', [Number(b.dataset.del)]);
      if (!confirm(`Delete "${d.name}"? Its activities, reviews and enquiries will also be removed.`)) return;
      DB.run('DELETE FROM destinations WHERE id = ?', [Number(b.dataset.del)]);
      updateTripCount();
      toast('Destination deleted');
      adminDestinations(body);
    }));
  }

  function destinationForm(id, done) {
    const d = id ? DB.one('SELECT * FROM destinations WHERE id = ?', [id]) : { lat: -19.0, lng: 29.8, entry_fee_usd: 0 };
    openModal({
      title: id ? 'Edit destination' : 'Add destination',
      body: `<form id="destForm">
        <div class="field"><label>Name *</label><input name="name" required value="${esc(d.name)}"></div>
        <div class="row">
          <div class="field"><label>Category *</label><select name="category_id">${categoryOptions(d.category_id)}</select></div>
          <div class="field"><label>Province *</label><select name="province">${provinceOptions(d.province)}</select></div>
        </div>
        <div class="field"><label>Nearest town</label><input name="nearest_town" value="${esc(d.nearest_town)}"></div>
        <div class="field"><label>Location (click the map to set)</label><div id="pickMap" style="height:200px;border:1px solid var(--line);border-radius:6px"></div></div>
        <div class="row">
          <div class="field"><label>Latitude *</label><input name="lat" type="number" step="0.0001" required value="${d.lat}"></div>
          <div class="field"><label>Longitude *</label><input name="lng" type="number" step="0.0001" required value="${d.lng}"></div>
        </div>
        <div class="field"><label>Short summary * (one sentence)</label><input name="summary" required maxlength="200" value="${esc(d.summary)}"></div>
        <div class="field"><label>Full description</label><textarea name="description">${esc(d.description)}</textarea></div>
        <div class="row">
          <div class="field"><label>Entry fee (USD)</label><input name="entry_fee_usd" type="number" min="0" step="1" value="${d.entry_fee_usd}"></div>
          <div class="field"><label>Best time to visit</label><input name="best_time" value="${esc(d.best_time)}"></div>
        </div>
        <div class="field"><label>Fee note</label><input name="fee_note" value="${esc(d.fee_note)}"></div>
        <div class="field"><label>Getting there</label><textarea name="access_info" style="min-height:60px">${esc(d.access_info)}</textarea></div>
        <div class="field"><label>Image URL (optional)</label><input name="image_url" type="url" placeholder="https://..." value="${esc(d.image_url)}"></div>
        <label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" name="featured" style="width:auto" ${d.featured ? 'checked' : ''}> Show on the home page as featured</label>
        <div id="dErr" class="small" style="color:var(--danger);margin-top:10px"></div>
      </form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="saveDest">Save</button>`,
      onMount: m => {
        const form = $('#destForm', m);
        const pick = L.map($('#pickMap', m)).fitBounds(ZIM_BOUNDS);
        addTiles(pick);
        const pin = L.circleMarker([d.lat, d.lng], { radius: 8, color: '#fff', weight: 2, fillColor: '#1f4a34', fillOpacity: 1 }).addTo(pick);
        pick.on('click', e => {
          pin.setLatLng(e.latlng);
          form.lat.value = e.latlng.lat.toFixed(4);
          form.lng.value = e.latlng.lng.toFixed(4);
        });
        setTimeout(() => { pick.invalidateSize(); pick.fitBounds(ZIM_BOUNDS); }, 50);

        $('#saveDest', m).addEventListener('click', () => {
          const fd = new FormData(form);
          const v = k => (fd.get(k) || '').toString().trim();
          const lat = Number(v('lat')), lng = Number(v('lng'));
          const errs = [];
          if (!v('name')) errs.push('Name is required.');
          if (!v('summary')) errs.push('Summary is required.');
          if (!(lat <= -15 && lat >= -23 && lng >= 25 && lng <= 34)) errs.push('Coordinates must be inside Zimbabwe.');
          if (errs.length) { $('#dErr', m).textContent = errs.join(' '); return; }
          const vals = [v('name'), Number(v('category_id')), v('province'), v('nearest_town'), lat, lng, v('summary'), v('description'),
            v('best_time'), Number(v('entry_fee_usd')) || 0, v('fee_note'), v('access_info'), v('image_url') || null, fd.get('featured') ? 1 : 0];
          if (id) {
            DB.run(`UPDATE destinations SET name=?, category_id=?, province=?, nearest_town=?, lat=?, lng=?, summary=?, description=?,
              best_time=?, entry_fee_usd=?, fee_note=?, access_info=?, image_url=?, featured=? WHERE id=?`, [...vals, id]);
          } else {
            DB.run(`INSERT INTO destinations (name, category_id, province, nearest_town, lat, lng, summary, description,
              best_time, entry_fee_usd, fee_note, access_info, image_url, featured) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, vals);
          }
          pick.remove();
          closeModal();
          toast(id ? 'Destination updated' : 'Destination added');
          done();
        });
      },
    });
  }

  function adminActivities(body, params) {
    const destId = params.get('dest') || '';
    const dests = DB.all('SELECT id, name FROM destinations ORDER BY name');
    const rows = DB.all(`SELECT a.*, d.name AS dest FROM activities a JOIN destinations d ON d.id = a.destination_id
      ${destId ? 'WHERE a.destination_id = ?' : ''} ORDER BY d.name, a.price_usd`, destId ? [Number(destId)] : []);
    body.innerHTML = `
      <div class="admin-bar">
        <select id="actFilter" style="max-width:280px"><option value="">All destinations</option>${dests.map(d => `<option value="${d.id}" ${String(d.id) === destId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
        <button class="btn btn-primary" id="addAct">Add activity</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Activity</th><th>Destination</th><th>Duration</th><th class="num">Price</th><th></th></tr></thead>
        <tbody>${rows.map(a => `<tr>
          <td><strong>${esc(a.name)}</strong><div class="small">${esc(a.provider || '')}</div></td><td>${esc(a.dest)}</td><td>${esc(a.duration || '')}</td>
          <td class="num">${money(a.price_usd)}</td>
          <td class="num"><button class="btn btn-sm" data-edit="${a.id}">Edit</button> <button class="btn btn-sm btn-danger" data-del="${a.id}">Delete</button></td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">No activities.</td></tr>'}</tbody></table></div>`;

    $('#actFilter').addEventListener('change', e => { location.hash = '#/admin?tab=activities' + (e.target.value ? '&dest=' + e.target.value : ''); });
    const refresh = () => adminActivities(body, params);
    $('#addAct').addEventListener('click', () => activityForm(null, destId, dests, refresh));
    $$('[data-edit]', body).forEach(b => b.addEventListener('click', () => activityForm(Number(b.dataset.edit), destId, dests, refresh)));
    $$('[data-del]', body).forEach(b => b.addEventListener('click', () => {
      if (!confirm('Delete this activity?')) return;
      DB.run('DELETE FROM activities WHERE id = ?', [Number(b.dataset.del)]);
      toast('Activity deleted');
      refresh();
    }));
  }

  function activityForm(id, destId, dests, done) {
    const a = id ? DB.one('SELECT * FROM activities WHERE id = ?', [id]) : { destination_id: Number(destId) || dests[0]?.id, price_usd: 0 };
    openModal({
      title: id ? 'Edit activity' : 'Add activity',
      body: `<form id="actForm">
        <div class="field"><label>Destination *</label><select name="destination_id">${dests.map(d => `<option value="${d.id}" ${d.id === a.destination_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Activity name *</label><input name="name" required value="${esc(a.name)}"></div>
        <div class="row">
          <div class="field"><label>Price from (USD)</label><input name="price_usd" type="number" min="0" value="${a.price_usd}"></div>
          <div class="field"><label>Duration</label><input name="duration" placeholder="e.g. Half day" value="${esc(a.duration)}"></div>
        </div>
        <div class="field"><label>Provider</label><input name="provider" value="${esc(a.provider)}"></div>
        <div class="field"><label>Notes</label><input name="notes" value="${esc(a.notes)}"></div>
        <div id="aErr" class="small" style="color:var(--danger)"></div>
      </form>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="saveAct">Save</button>`,
      onMount: m => $('#saveAct', m).addEventListener('click', () => {
        const fd = new FormData($('#actForm', m));
        const v = k => (fd.get(k) || '').toString().trim();
        if (!v('name')) { $('#aErr', m).textContent = 'Activity name is required.'; return; }
        const vals = [Number(v('destination_id')), v('name'), Number(v('price_usd')) || 0, v('duration'), v('provider'), v('notes')];
        if (id) DB.run('UPDATE activities SET destination_id=?, name=?, price_usd=?, duration=?, provider=?, notes=? WHERE id=?', [...vals, id]);
        else DB.run('INSERT INTO activities (destination_id, name, price_usd, duration, provider, notes) VALUES (?,?,?,?,?,?)', vals);
        closeModal();
        toast(id ? 'Activity updated' : 'Activity added');
        done();
      }),
    });
  }

  function adminEnquiries(body, params) {
    const status = params.get('status') || '';
    const rows = DB.all(`SELECT e.*, d.name AS dest, a.name AS act FROM enquiries e
      JOIN destinations d ON d.id = e.destination_id LEFT JOIN activities a ON a.id = e.activity_id
      ${status ? 'WHERE e.status = ?' : ''} ORDER BY e.created_at DESC`, status ? [status] : []);
    body.innerHTML = `
      <div class="admin-bar">
        <select id="stFilter" style="max-width:200px">
          ${['', 'New', 'Responded', 'Closed'].map(s => `<option value="${s}" ${s === status ? 'selected' : ''}>${s || 'All statuses'}</option>`).join('')}
        </select>
        <span class="muted small">${rows.length} enquir${rows.length === 1 ? 'y' : 'ies'}</span>
      </div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Reference</th><th>Visitor</th><th>Request</th><th>Travel</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map(e => `<tr>
          <td style="font-family:var(--mono);font-size:13px">${esc(e.reference)}<div class="small">${fmtDate(e.created_at)}</div></td>
          <td>${esc(e.full_name)}<div class="small"><a href="mailto:${esc(e.email)}">${esc(e.email)}</a>${e.phone ? '<br>' + esc(e.phone) : ''}</div></td>
          <td>${esc(e.dest)}<div class="small">${esc(e.act || 'General enquiry')}${e.message ? '<br>“' + esc(e.message) + '”' : ''}</div></td>
          <td>${e.travel_date ? fmtDate(e.travel_date) : '—'}<div class="small">${e.group_size} ${e.group_size == 1 ? 'person' : 'people'}</div></td>
          <td><select data-status="${e.id}" style="padding:4px 6px;font-size:13px">${['New', 'Responded', 'Closed'].map(s => `<option ${s === e.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
          <td class="num"><button class="btn btn-sm btn-danger" data-del="${e.id}">Delete</button></td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No enquiries found.</div>'}`;

    $('#stFilter').addEventListener('change', e => { location.hash = '#/admin?tab=enquiries' + (e.target.value ? '&status=' + e.target.value : ''); });
    $$('[data-status]', body).forEach(s => s.addEventListener('change', () => {
      DB.run('UPDATE enquiries SET status = ? WHERE id = ?', [s.value, Number(s.dataset.status)]);
      toast('Status updated');
    }));
    $$('[data-del]', body).forEach(b => b.addEventListener('click', () => {
      if (!confirm('Delete this enquiry?')) return;
      DB.run('DELETE FROM enquiries WHERE id = ?', [Number(b.dataset.del)]);
      adminEnquiries(body, params);
    }));
  }

  function adminReviews(body) {
    const rows = DB.all(`SELECT r.*, d.name AS dest FROM reviews r JOIN destinations d ON d.id = r.destination_id ORDER BY r.created_at DESC`);
    body.innerHTML = `
      <p class="muted">Remove reviews that are abusive, fake or off-topic.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Destination</th><th>Author</th><th>Rating</th><th>Comment</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${esc(r.dest)}</td><td>${esc(r.author)}<div class="small">${fmtDate(r.created_at)}</div></td><td>${stars(r.rating)}</td>
          <td style="max-width:360px">${esc(r.comment || '')}</td><td class="num"><button class="btn btn-sm btn-danger" data-del="${r.id}">Remove</button></td></tr>`).join('')}</tbody>
      </table></div>`;
    $$('[data-del]', body).forEach(b => b.addEventListener('click', () => {
      if (!confirm('Remove this review?')) return;
      DB.run('DELETE FROM reviews WHERE id = ?', [Number(b.dataset.del)]);
      adminReviews(body);
    }));
  }

  function adminDatabase(body) {
    const counts = ['categories', 'destinations', 'activities', 'reviews', 'enquiries', 'trip_items']
      .map(t => ({ t, n: DB.one(`SELECT COUNT(*) AS n FROM ${t}`).n }));
    body.innerHTML = `
      <div class="trip-grid" style="padding:0">
        <div class="panel">
          <h3>SQLite database</h3>
          <p class="muted small">All data is stored in a SQLite database that runs inside the browser. It is saved automatically on this device. Export it to back up or move the data to another computer.</p>
          <div class="table-wrap" style="margin-bottom:16px"><table><thead><tr><th>Table</th><th class="num">Rows</th></tr></thead>
            <tbody>${counts.map(c => `<tr><td style="font-family:var(--mono);font-size:13px">${c.t}</td><td class="num">${c.n}</td></tr>`).join('')}</tbody></table></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" id="dbExport">Export .sqlite</button>
            <label class="btn" style="margin:0;font-size:14px;font-weight:500;color:var(--ink)">Import .sqlite<input type="file" id="dbImport" accept=".sqlite,.db,.sqlite3" hidden></label>
            <button class="btn btn-danger" id="dbReset">Reset to sample data</button>
          </div>
        </div>
        <div class="panel">
          <h3>SQL console</h3>
          <p class="muted small">Run queries directly against the database. Changes are saved immediately.</p>
          <textarea class="code" id="sqlIn">SELECT d.name, COUNT(e.id) AS enquiries
FROM destinations d LEFT JOIN enquiries e ON e.destination_id = d.id
GROUP BY d.id ORDER BY enquiries DESC LIMIT 10;</textarea>
          <button class="btn btn-primary" id="sqlRun" style="margin-top:8px">Run query</button>
          <div class="sql-out" id="sqlOut"></div>
        </div>
      </div>`;

    $('#dbExport').addEventListener('click', () => DB.exportFile());
    $('#dbImport').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try { await DB.importFile(file); updateTripCount(); toast('Database imported'); adminDatabase(body); }
      catch (err) { alert('Import failed: ' + err.message); }
    });
    $('#dbReset').addEventListener('click', () => {
      if (!confirm('Reset the database? All enquiries, reviews and changes will be lost.')) return;
      DB.reset();
      updateTripCount();
      toast('Database reset');
      adminDatabase(body);
    });
    $('#sqlRun').addEventListener('click', () => {
      const out = $('#sqlOut');
      try {
        const res = DB.rawExec($('#sqlIn').value);
        updateTripCount();
        if (!res.length) { out.innerHTML = '<p class="muted">Query ran. No rows returned.</p>'; return; }
        const r = res[res.length - 1];
        out.innerHTML = `<p class="muted">${r.values.length} row(s)</p><div class="table-wrap"><table><thead><tr>${r.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${r.values.map(row => `<tr>${row.map(v => `<td>${esc(v === null ? 'NULL' : v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      } catch (err) {
        out.innerHTML = `<p style="color:var(--danger)">${esc(err.message)}</p>`;
      }
    });
  }

  /* ---------------------------------------------------------------------
     Router
     --------------------------------------------------------------------- */
  function route() {
    closeModal();
    destroyMaps();
    const { parts, params } = parseHash();
    const page = parts[0] || 'home';
    $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === (page === 'destination' ? 'explore' : page)));
    $('#nav').classList.remove('open');
    window.scrollTo(0, 0);

    if (page === 'explore') viewExplore(params);
    else if (page === 'destination') viewDestination(parts[1]);
    else if (page === 'trip') viewTrip();
    else if (page === 'admin') viewAdmin(params);
    else viewHome();

    const titles = { explore: 'Explore map', trip: 'My trip', admin: 'Operator portal' };
    document.title = (page === 'destination' ? (getDestination(parts[1])?.name || 'Destination') : titles[page] || 'Explore Zimbabwe') + ' — ZimTrails';
  }

  $('#navToggle').addEventListener('click', () => $('#nav').classList.toggle('open'));
  window.addEventListener('hashchange', route);

  DB.init()
    .then(() => { updateTripCount(); route(); })
    .catch(err => {
      console.error(err);
      app.innerHTML = `<div class="wrap section"><div class="empty">The database could not be loaded: ${esc(err.message)}</div></div>`;
    });
})();
