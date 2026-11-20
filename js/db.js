/* ==========================================================================
   ZimTrails — database layer
   Runs a real SQLite database in the browser using sql.js.
   The database file is saved to the browser's localStorage after every
   change, and can be exported / imported as a standard .sqlite file.
   ========================================================================== */

const DB = (() => {
  const STORAGE_KEY = 'zimtrails.sqlite.v1';
  let db = null;

  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS categories (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL UNIQUE,
      blurb TEXT
    );

    CREATE TABLE IF NOT EXISTS destinations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      category_id   INTEGER NOT NULL REFERENCES categories(id),
      province      TEXT NOT NULL,
      nearest_town  TEXT,
      lat           REAL NOT NULL,
      lng           REAL NOT NULL,
      summary       TEXT NOT NULL,
      description   TEXT,
      best_time     TEXT,
      entry_fee_usd REAL DEFAULT 0,
      fee_note      TEXT,
      access_info   TEXT,
      image_url     TEXT,
      featured      INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activities (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      price_usd      REAL DEFAULT 0,
      duration       TEXT,
      provider       TEXT,
      notes          TEXT
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
      author         TEXT NOT NULL,
      rating         INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment        TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS enquiries (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      reference      TEXT NOT NULL UNIQUE,
      destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
      activity_id    INTEGER REFERENCES activities(id) ON DELETE SET NULL,
      full_name      TEXT NOT NULL,
      email          TEXT NOT NULL,
      phone          TEXT,
      travel_date    TEXT,
      group_size     INTEGER DEFAULT 1,
      message        TEXT,
      status         TEXT DEFAULT 'New',
      created_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trip_items (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      destination_id INTEGER NOT NULL UNIQUE REFERENCES destinations(id) ON DELETE CASCADE,
      position       INTEGER NOT NULL,
      nights         INTEGER DEFAULT 1,
      notes          TEXT
    );
  `;

  /* ---------- Seed data (fees and prices are indicative, in USD) ---------- */
  const CATEGORIES = [
    ['Wildlife & Safari', 'National parks with game drives, walking safaris and canoe trails.'],
    ['Heritage & History', 'Stone-built cities, rock art and national monuments.'],
    ['Waterfalls & Rivers', 'The Zambezi, gorges and highland falls.'],
    ['Mountains & Hiking', 'Cool Eastern Highlands, trails and viewpoints.'],
    ['Lakes & Recreation', 'Houseboats, fishing, picnics and weekend getaways.'],
    ['Caves & Geology', 'Caves, granite domes and unusual landforms.'],
  ];

  // [name, categoryIndex(1-based), province, nearestTown, lat, lng, summary, description, bestTime, fee, feeNote, access, featured]
  const DESTINATIONS = [
    ['Victoria Falls', 3, 'Matabeleland North', 'Victoria Falls', -17.9243, 25.8572,
      'One of the largest curtains of falling water in the world, known locally as Mosi-oa-Tunya.',
      'The Zambezi drops more than 100 metres into a narrow basalt gorge along a 1.7 km front. The Zimbabwean side gives views of most of the main falls from 16 viewpoints along the rainforest trail. The town is the country’s main adventure hub, with rafting, bungee jumping, river cruises and helicopter flights all within a short drive.',
      'February–May for full flow; August–December for clearer views and low-water rafting.', 50,
      'Rainforest entry; lower rates for SADC visitors and Zimbabwean residents.',
      'Victoria Falls International Airport (VFA) is 20 km from town. Daily coaches run from Bulawayo (about 5 hours).', 1],
    ['Hwange National Park', 1, 'Matabeleland North', 'Hwange', -18.7317, 26.9553,
      'Zimbabwe’s largest national park, famous for its very large elephant herds.',
      'Covering roughly 14,600 km², Hwange holds over 100 mammal species and 400 bird species. Pumped waterholes draw game in the dry season, making it one of the most reliable places in the region to see elephant, buffalo, lion and wild dog.',
      'July–October (dry season, animals gather at waterholes).', 20,
      'Daily conservation fee per adult. Vehicle fees apply for self-drive.',
      'Main Camp is about 2 hours by road from Victoria Falls on the A8. A 4x4 is recommended for remote sections.', 1],
    ['Mana Pools National Park', 1, 'Mashonaland West', 'Karoi', -15.7690, 29.3760,
      'A UNESCO World Heritage Site on the Zambezi floodplain, known for walking safaris and canoeing.',
      'Mana Pools is one of the few parks in Africa where unguided walking is permitted. Old acacia woodland, oxbow pools and the Zambezi River make it a favourite for photographers. Canoe trails run between Mana and Kanyemba.',
      'May–October. Many roads close in the rainy season (November–April).', 20,
      'Conservation fee per adult per day. Camping booked through ZimParks.',
      'About 6 hours from Harare via Karoi and Marongora, where permits are collected. 4x4 required.', 1],
    ['Great Zimbabwe National Monument', 2, 'Masvingo', 'Masvingo', -20.2675, 30.9338,
      'The ruins of a medieval stone city that gave the country its name.',
      'Built between the 11th and 15th centuries, Great Zimbabwe was the capital of a trading kingdom linked to the Indian Ocean coast. The Hill Complex, the Great Enclosure with its conical tower and the Valley Ruins are all walkable. The site museum holds the famous soapstone birds.',
      'All year. April–August is cooler for walking.', 15,
      'Includes museum entry. Guided tours charged separately.',
      '27 km south-east of Masvingo town, about 4 hours from Harare on the A4.', 1],
    ['Matobo National Park', 2, 'Matabeleland South', 'Bulawayo', -20.5480, 28.5030,
      'Balancing granite kopjes, San rock art and one of the highest densities of rhino in Zimbabwe.',
      'The Matobo Hills are a UNESCO World Heritage cultural landscape. Visitors can track white rhino on foot, see rock paintings at Nswatugi and Pomongwe caves, and climb to World’s View (Malindidzimu) for sunset.',
      'April–October.', 15,
      'Park entry per adult; rhino tracking priced per person.',
      '35 km south of Bulawayo on a tarred road.', 1],
    ['Lake Kariba', 5, 'Mashonaland West', 'Kariba', -16.5167, 28.8000,
      'A vast man-made lake known for houseboats, tiger fishing and sunsets over drowned forests.',
      'Created by the Kariba Dam in the late 1950s, the lake stretches about 220 km along the border with Zambia. Kariba town is the base for houseboat hire, fishing trips and visits to the dam wall.',
      'All year. The Kariba Invitation Tiger Fish Tournament is held in October.', 0,
      'No general entry fee; dam wall and boat licences charged separately.',
      'About 5 hours’ drive from Harare via Makuti. Charter flights also land at Kariba.', 1],
    ['Nyanga National Park', 4, 'Manicaland', 'Nyanga', -18.2167, 32.7500,
      'Cool highland moorland, trout dams and Mount Nyangani, the country’s highest peak.',
      'Nyanga offers hiking, trout fishing, horse riding and golf in a climate much cooler than the rest of the country. Mount Nyangani (2,592 m) can be climbed in a day. Mtarazi and Nyangombe falls are within reach.',
      'March–November. Winter nights can be cold.', 10,
      'Park entry per adult; fishing licences extra.',
      'About 3 hours from Harare via Rusape.', 0],
    ['Mutarazi Falls & Skywalk', 3, 'Manicaland', 'Nyanga', -18.5280, 32.8070,
      'Zimbabwe’s highest waterfall, with a skywalk and zipline over the Honde Valley.',
      'The falls drop about 762 metres in two stages. A suspended skywalk and one of the longest ziplines in Africa give views across the Honde Valley.',
      'All year; strongest flow in the rainy season.', 10,
      'Park entry; skywalk and zipline charged per person.',
      'Inside the Mutarazi Falls National Park, south of Nyanga. Final road section is gravel.', 0],
    ['Chimanimani National Park', 4, 'Manicaland', 'Chimanimani', -19.7900, 33.0500,
      'Rugged quartzite mountains with multi-day hiking routes and wild swimming pools.',
      'Chimanimani is a hiker’s park with no roads inside. Trails lead to the mountain hut, Bundi River pools and Mount Binga on the Mozambique border. The village is recovering well after Cyclone Idai and welcomes visitors.',
      'April–October.', 10,
      'Entry and overnight hut fees per person.',
      'About 150 km south of Mutare. Park entrance at Mutekeswane base camp.', 0],
    ['Gonarezhou National Park', 1, 'Masvingo', 'Chiredzi', -21.6500, 31.7000,
      'Remote wilderness with the red sandstone Chilojo Cliffs and large elephant herds.',
      'Gonarezhou, meaning “place of many elephants”, forms part of the Great Limpopo Transfrontier Park. It is less visited than Hwange, offering quiet game viewing, camping along the Runde River and views from the Chilojo Cliffs.',
      'May–October.', 15,
      'Conservation fee per adult per day.',
      'Access via Chiredzi. 4x4 needed beyond the main roads.', 0],
    ['Matusadona National Park', 1, 'Mashonaland West', 'Kariba', -16.9500, 28.5500,
      'Lakeshore park on Kariba, reached mainly by boat, with lion, buffalo and elephant.',
      'Bounded by Lake Kariba and the Zambezi escarpment, Matusadona combines boat safaris, walking and game drives. Lodges on the shoreline offer some of the best sunset views in the country.',
      'May–November.', 20,
      'Conservation fee per adult per day.',
      'Usually reached by boat or light aircraft from Kariba town.', 0],
    ['Khami Ruins', 2, 'Bulawayo', 'Bulawayo', -20.1560, 28.3780,
      'UNESCO-listed stone ruins that succeeded Great Zimbabwe as a regional capital.',
      'Khami was the capital of the Torwa state from the 15th to the 17th century. Its decorated terraced platforms are among the finest examples of dry-stone walling in southern Africa.',
      'All year.', 10, 'Entry per adult.',
      '22 km west of Bulawayo city centre.', 0],
    ['Chinhoyi Caves', 6, 'Mashonaland West', 'Chinhoyi', -17.3550, 30.1250,
      'Limestone caves around the striking cobalt-blue Sleeping Pool.',
      'The Sleeping Pool (Chirorodziva) is so clear that sunlight reaches deep below the surface. Paths and steps lead down to the water and through the Dark Cave. It is a common stop on the road from Harare to Kariba.',
      'All year.', 10, 'Entry per adult. Diving by arrangement only.',
      '8 km north of Chinhoyi on the A1 Harare–Chirundu road.', 0],
    ['Domboshava Caves', 6, 'Mashonaland East', 'Harare', -17.6200, 31.1700,
      'A granite dome with rock paintings and wide views, 30 minutes from Harare.',
      'Domboshava is a popular short hike from the capital. A gentle climb over the granite leads to a shelter with ancient rock art and panoramic views, ideal at sunset.',
      'All year.', 10, 'Entry per adult.',
      '27 km north-east of Harare on Domboshava Road.', 0],
    ['Lake Chivero Recreational Park', 5, 'Mashonaland West', 'Norton', -17.9000, 30.8000,
      'Harare’s nearest game park and lake, popular for day trips and weekends.',
      'The park on the south bank of Lake Chivero has giraffe, zebra and antelope that can be seen on foot or horseback, as well as Bushman Point rock paintings and lakeside lodges.',
      'All year.', 10, 'Entry per adult.',
      '32 km south-west of Harare via the Bulawayo road.', 0],
    ['Bvumba Mountains', 4, 'Manicaland', 'Mutare', -19.1000, 32.7700,
      'Misty forested mountains with botanical gardens and excellent birding.',
      'Known as the “Mountains of the Mist”, Bvumba has the Bvumba Botanical Gardens, forest walks, coffee farms and some of Zimbabwe’s rarest forest birds.',
      'All year; August–December for birding.', 10, 'Botanical gardens entry.',
      '28 km south-east of Mutare on a winding tarred road.', 0],
    ['Mukuvisi Woodlands', 1, 'Harare', 'Harare', -17.8420, 31.0890,
      'A protected woodland in the city where you can walk among giraffe and zebra.',
      'Mukuvisi is a 265-hectare reserve close to central Harare with walking trails, horse rides, a bird hide and an environmental education centre.',
      'All year.', 5, 'Entry per adult.',
      'About 5 km east of central Harare, off Glenara Avenue.', 0],
    ['Lake Mutirikwi', 5, 'Masvingo', 'Masvingo', -20.2000, 31.0000,
      'A large lake next to Great Zimbabwe, with a small game park and boating.',
      'Lake Mutirikwi (formerly Kyle) is the second-largest inland lake in Zimbabwe. The recreational park on its northern shore has white rhino and antelope, and it pairs well with a visit to Great Zimbabwe.',
      'All year.', 10, 'Park entry per adult.',
      'About 30 km south-east of Masvingo.', 0],
  ];

  // [destinationIndex(1-based), name, price, duration, provider, notes]
  const ACTIVITIES = [
    [1, 'Guided rainforest walk', 20, '2 hours', 'Licensed local guide', 'Raincoat recommended in high water.'],
    [1, 'White-water rafting (Batoka Gorge)', 150, 'Full day', 'Registered rafting operator', 'Low-water season only, roughly August–December.'],
    [1, 'Zambezi sunset cruise', 65, '2.5 hours', 'River cruise operator', 'Includes drinks and snacks.'],
    [1, 'Helicopter flight over the falls', 180, '13 minutes', 'Licensed aviation operator', 'Book a day ahead in peak season.'],
    [1, 'Bridge bungee jump', 160, '1 hour', 'Victoria Falls Bridge operator', 'Passport required at the bridge.'],
    [2, 'Morning game drive', 60, '4 hours', 'Main Camp safari operator', 'Departs at sunrise.'],
    [2, 'Guided walking safari', 50, '3 hours', 'ZimParks-licensed walking guide', 'Minimum age 16.'],
    [3, 'Canoe safari on the Zambezi', 120, 'Half day', 'Licensed canoe guide', 'Multi-day trails also available.'],
    [3, 'Walking safari', 60, '3 hours', 'Professional guide', ''],
    [4, 'Guided tour of the Hill Complex and Great Enclosure', 10, '2 hours', 'Site guide (National Museums)', ''],
    [4, 'Cultural village visit', 8, '1 hour', 'Community cultural village', 'Traditional dance on request.'],
    [5, 'Rhino tracking on foot', 75, 'Half day', 'Licensed rhino guide', 'Sturdy shoes required.'],
    [5, 'Rock art and World’s View tour', 45, 'Half day', 'Local heritage guide', ''],
    [6, 'Houseboat charter (per person per night)', 120, 'Overnight', 'Houseboat operator', 'Full board options available.'],
    [6, 'Tiger fishing trip', 80, 'Half day', 'Fishing charter', 'Rods and bait supplied.'],
    [7, 'Mount Nyangani guided climb', 25, '5–6 hours', 'Park ranger guide', 'Mist can roll in quickly; a guide is strongly advised.'],
    [7, 'Trout fishing', 15, 'Per day', 'ZimParks', 'Licence required.'],
    [8, 'Skywalk', 15, '1 hour', 'Mutarazi adventure operator', ''],
    [8, 'Zipline across the gorge', 40, '30 minutes', 'Mutarazi adventure operator', 'Weight limits apply.'],
    [9, 'Guided overnight hike to the mountain hut', 40, '2 days', 'Local hiking guide', 'Bring sleeping bag and food.'],
    [10, 'Chilojo Cliffs game drive', 70, 'Full day', 'Safari operator', ''],
    [11, 'Boat safari', 55, '3 hours', 'Lodge boat guide', ''],
    [12, 'Guided heritage walk', 10, '1.5 hours', 'National Museums guide', ''],
    [13, 'Guided cave walk', 5, '1 hour', 'Site guide', ''],
    [14, 'Sunset hike', 10, '2 hours', 'Community guide', ''],
    [15, 'Horseback game viewing', 35, '2 hours', 'Lakeside stables', ''],
    [16, 'Forest birding walk', 30, '3 hours', 'Specialist bird guide', 'Best early morning.'],
    [17, 'Woodland walk with giraffe', 10, '1.5 hours', 'Mukuvisi guide', ''],
    [18, 'Boat cruise on the lake', 25, '2 hours', 'Lake boat operator', ''],
  ];

  const REVIEWS = [
    [1, 'Tendai M.', 5, 'Went in April and got completely soaked on the trail. Worth every cent.'],
    [1, 'Sarah K.', 4, 'Amazing views. The town is pricey, so set a budget before you go.'],
    [2, 'Farai C.', 5, 'Saw more than 60 elephants at one waterhole near Main Camp.'],
    [4, 'Nyasha D.', 5, 'The guide made the history come alive. Go early before it gets hot.'],
    [5, 'Peter J.', 5, 'Rhino tracking was the highlight of our trip to Zimbabwe.'],
    [7, 'Rudo P.', 4, 'Beautiful and cool. Take warm clothes for the evenings.'],
    [13, 'Kuda S.', 4, 'The blue of the pool is unreal. A good stop on the way to Kariba.'],
    [14, 'Chipo N.', 4, 'Quick escape from Harare. Sunsets are lovely.'],
  ];

  /* ---------- Helpers ---------- */
  function toBase64(u8) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function fromBase64(b64) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  function seed() {
    db.exec('BEGIN');
    const c = db.prepare('INSERT INTO categories (name, blurb) VALUES (?, ?)');
    CATEGORIES.forEach(r => c.run(r));
    c.free();

    const d = db.prepare(`INSERT INTO destinations
      (name, category_id, province, nearest_town, lat, lng, summary, description,
       best_time, entry_fee_usd, fee_note, access_info, featured)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    DESTINATIONS.forEach(r => d.run(r));
    d.free();

    const a = db.prepare(`INSERT INTO activities
      (destination_id, name, price_usd, duration, provider, notes) VALUES (?,?,?,?,?,?)`);
    ACTIVITIES.forEach(r => a.run(r));
    a.free();

    const rv = db.prepare(`INSERT INTO reviews (destination_id, author, rating, comment, created_at)
      VALUES (?,?,?,?, datetime('now', ?))`);
    REVIEWS.forEach((r, i) => rv.run([...r, `-${(i + 1) * 9} days`]));
    rv.free();
    db.exec('COMMIT');
  }

  /* ---------- Public API ---------- */
  async function init() {
    const SQL = await initSqlJs();
    let saved = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) { /* storage unavailable */ }

    if (saved) {
      try { db = new SQL.Database(fromBase64(saved)); }
      catch (e) { console.warn('Saved database was unreadable, starting fresh.', e); db = null; }
    }
    if (!db) {
      db = new SQL.Database();
      db.exec(SCHEMA);
      seed();
      persist();
    }
    db.exec('PRAGMA foreign_keys = ON;');
    window.__SQL = SQL;
    return db;
  }

  /* sql.js re-opens the database inside export(), which resets PRAGMAs,
     so foreign-key enforcement is switched back on every time. */
  function exportBytes() {
    const bytes = db.export();
    db.exec('PRAGMA foreign_keys = ON;');
    return bytes;
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, toBase64(exportBytes())); }
    catch (e) { console.warn('Could not save database to browser storage.', e); }
  }

  /** Run a SELECT and return an array of plain objects. */
  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function one(sql, params = []) {
    return all(sql, params)[0] || null;
  }

  /** Run INSERT / UPDATE / DELETE, save, and return the last insert id. */
  function run(sql, params = []) {
    db.run(sql, params);
    const id = one('SELECT last_insert_rowid() AS id').id;
    persist();
    return id;
  }

  function exportFile() {
    const blob = new Blob([exportBytes()], { type: 'application/x-sqlite3' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `zimtrails-${new Date().toISOString().slice(0, 10)}.sqlite`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  async function importFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const candidate = new window.__SQL.Database(buf);
    // Basic validation: the required tables must exist.
    const tables = candidate.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const names = tables.length ? tables[0].values.map(v => v[0]) : [];
    const required = ['destinations', 'activities', 'categories', 'reviews', 'enquiries', 'trip_items'];
    const missing = required.filter(t => !names.includes(t));
    if (missing.length) {
      candidate.close();
      throw new Error('This file is missing tables: ' + missing.join(', '));
    }
    db.close();
    db = candidate;
    db.exec('PRAGMA foreign_keys = ON;');
    persist();
  }

  function reset() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    db.close();
    db = new window.__SQL.Database();
    db.exec(SCHEMA);
    seed();
    db.exec('PRAGMA foreign_keys = ON;');
    persist();
  }

  /** Raw query for the admin SQL console. Returns sql.js result sets. */
  function rawExec(sql) {
    const res = db.exec(sql);
    if (!/^\s*select/i.test(sql)) persist();
    return res;
  }

  return { init, all, one, run, exportFile, importFile, reset, rawExec };
})();
