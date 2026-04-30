require('dotenv').config();
const express = require('express');
const { neon } = require('@neondatabase/serverless');
const { put, del } = require('@vercel/blob');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const IS_VERCEL = !!process.env.VERCEL;

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);

const sql = neon(process.env.DATABASE_URL);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_DIR  = path.join(__dirname, '..', 'admin');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

if (!IS_VERCEL && !fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── File helpers ──────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(
      path.extname(file.originalname).toLowerCase()
    ));
  },
});

async function storeFile(file) {
  const ext      = path.extname(file.originalname).toLowerCase();
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;

  if (IS_VERCEL) {
    const blob = await put(filename, file.buffer, { access: 'public', contentType: file.mimetype });
    return { filename, url: blob.url };
  } else {
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.buffer);
    return { filename, url: `/uploads/${filename}` };
  }
}

async function deleteFile(photo) {
  try {
    if (IS_VERCEL && photo.url?.startsWith('http')) {
      await del(photo.url);
    } else if (photo.filename) {
      const fp = path.join(UPLOAD_DIR, photo.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  } catch (e) {
    console.error('deleteFile:', e.message);
  }
}

// ─── DB init ───────────────────────────────────────────────────────────────────
async function initDB() {
  await sql`CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '', cover_photo_id INTEGER,
    sort_order INTEGER DEFAULT 0, visible INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS photos (
    id SERIAL PRIMARY KEY, category_id INTEGER REFERENCES categories(id),
    filename TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
    title TEXT DEFAULT '', description TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
  )`;

  await sql`CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY, name TEXT, email TEXT, phone TEXT, message TEXT,
    read INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS private_galleries (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    password TEXT NOT NULL UNIQUE, event_date TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS private_photos (
    id SERIAL PRIMARY KEY, gallery_id INTEGER REFERENCES private_galleries(id),
    filename TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
    sort_order INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW()
  )`;

  for (const [k, v] of [
    ['site_name',      'Arnoud Bex'],
    ['hero_title',     'Arnoud Bex'],
    ['hero_subtitle',  'Elk moment verdient een perfect beeld'],
    ['about_title',    'Over Mij'],
    ['about_text',     'Welkom op mijn portfolio. Ik ben een gepassioneerde fotograaf die de mooiste momenten vastlegt.\n\nFotografie is meer dan een foto nemen — het is een emotie, een verhaal, een herinnering voor altijd.'],
    ['about_quote',    'Een foto zegt meer dan 1000 woorden'],
    ['contact_email',  ''],
    ['contact_phone',  ''],
    ['contact_location', 'België'],
    ['instagram_url',  ''],
    ['facebook_url',   ''],
  ]) {
    await sql`INSERT INTO settings (key,value) VALUES (${k},${v}) ON CONFLICT (key) DO NOTHING`;
  }

  for (const [name, slug, desc, order] of [
    ['Kinderfotografie',  'kinderfotografie',  'Kinderen vastleggen in hun meest authentieke en ontspannen momenten', 1],
    ['Portretfotografie', 'portretfotografie', 'Professionele portretfotografie die jouw persoonlijkheid weerspiegelt', 2],
    ['Fotoshoot',         'fotoshoot',         'Persoonlijke fotoshoots op maat van jouw wensen', 3],
    ['Evenementen',       'evenementen',       'Evenementen, feesten en speciale gelegenheden vastgelegd', 4],
    ['Diversen',          'diversen',          'Diverse fotografie', 5],
  ]) {
    await sql`INSERT INTO categories (name,slug,description,sort_order) VALUES (${name},${slug},${desc},${order}) ON CONFLICT (slug) DO NOTHING`;
  }
}

// ─── Middleware ────────────────────────────────────────────────────────────────
// Lazy DB init on first request
let dbReady = null;
app.use(async (req, res, next) => {
  if (!dbReady) dbReady = initDB().catch(e => { dbReady = null; throw e; });
  try { await dbReady; next(); } catch (e) {
    console.error('DB init:', e);
    res.status(500).json({ error: 'Database niet beschikbaar' });
  }
});

app.use(express.json());
if (!IS_VERCEL) app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));
app.use('/admin', express.static(ADMIN_DIR));
app.get('/prive', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'prive.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(ADMIN_DIR, 'index.html')));

// ─── Auth ──────────────────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token verlopen' }); }
};

const privateAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });
  try { const p = jwt.verify(token, JWT_SECRET); req.galleryId = p.galleryId; next(); }
  catch { res.status(401).json({ error: 'Token verlopen' }); }
};

// ─── Public API ────────────────────────────────────────────────────────────────
app.get('/api/categories', async (req, res) => {
  try {
    const cats = await sql`
      SELECT c.*,
        COALESCE(cp.url, (SELECT url FROM photos WHERE category_id = c.id ORDER BY sort_order, created_at LIMIT 1)) AS cover_url,
        (SELECT COUNT(*)::int FROM photos WHERE category_id = c.id) AS photo_count
      FROM categories c
      LEFT JOIN photos cp ON c.cover_photo_id = cp.id
      WHERE c.visible = 1
      ORDER BY c.sort_order, c.name`;
    res.json(cats);
  } catch (e) { console.error(e); res.status(500).json({ error: 'DB fout' }); }
});

app.get('/api/categories/:slug', async (req, res) => {
  try {
    const [cat] = await sql`SELECT * FROM categories WHERE slug = ${req.params.slug} AND visible = 1`;
    if (!cat) return res.status(404).json({ error: 'Niet gevonden' });
    res.json(cat);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.get('/api/categories/:slug/photos', async (req, res) => {
  try {
    const [cat] = await sql`SELECT id FROM categories WHERE slug = ${req.params.slug}`;
    if (!cat) return res.status(404).json({ error: 'Niet gevonden' });
    res.json(await sql`SELECT * FROM photos WHERE category_id = ${cat.id} ORDER BY sort_order, created_at`);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.get('/api/settings', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM settings`;
    const obj = {}; rows.forEach(r => (obj[r.key] = r.value));
    res.json(obj);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.post('/api/contact', async (req, res) => {
  const { name, email, phone, message } = req.body;
  if (!name?.trim() || !email?.trim() || !message?.trim())
    return res.status(400).json({ error: 'Naam, e-mail en bericht zijn verplicht' });
  try {
    await sql`INSERT INTO contacts (name,email,phone,message) VALUES (${name},${email},${phone||''},${message})`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Admin login ───────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (!bcrypt.compareSync(req.body.password || '', ADMIN_HASH))
    return res.status(401).json({ error: 'Verkeerd wachtwoord' });
  res.json({ token: jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '24h' }) });
});

// ─── Admin: categories ─────────────────────────────────────────────────────────
app.get('/api/admin/categories', auth, async (req, res) => {
  try {
    res.json(await sql`
      SELECT c.*, COUNT(p.id)::int AS photo_count
      FROM categories c LEFT JOIN photos p ON p.category_id = c.id
      GROUP BY c.id ORDER BY c.sort_order, c.name`);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.post('/api/admin/categories', auth, async (req, res) => {
  const { name, description, visible } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Naam vereist' });
  const slug = name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    const [{ count }] = await sql`SELECT COUNT(*)::int as count FROM categories`;
    const [row] = await sql`
      INSERT INTO categories (name,slug,description,sort_order,visible)
      VALUES (${name.trim()},${slug},${description||''},${count+1},${visible!==false?1:0})
      RETURNING id, slug`;
    res.json({ id: row.id, name: name.trim(), slug: row.slug });
  } catch (e) {
    res.status(500).json({ error: e.message?.includes('unique') ? 'Naam al in gebruik' : 'DB fout' });
  }
});

app.put('/api/admin/categories/:id', auth, async (req, res) => {
  const { name, description, sort_order, visible } = req.body;
  try {
    await sql`UPDATE categories SET name=${name}, description=${description}, sort_order=${sort_order}, visible=${visible?1:0} WHERE id=${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.delete('/api/admin/categories/:id', auth, async (req, res) => {
  try {
    const photos = await sql`SELECT filename, url FROM photos WHERE category_id = ${req.params.id}`;
    await Promise.all(photos.map(deleteFile));
    await sql`DELETE FROM photos WHERE category_id = ${req.params.id}`;
    await sql`DELETE FROM categories WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.put('/api/admin/categories/:id/cover', auth, async (req, res) => {
  try {
    await sql`UPDATE categories SET cover_photo_id = ${req.body.photo_id} WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Admin: photos ─────────────────────────────────────────────────────────────
app.get('/api/admin/photos', auth, async (req, res) => {
  try {
    const { category_id } = req.query;
    res.json(category_id
      ? await sql`SELECT * FROM photos WHERE category_id = ${category_id} ORDER BY sort_order, created_at`
      : await sql`SELECT * FROM photos ORDER BY created_at DESC`);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.post('/api/admin/photos', auth, upload.array('photos', 100), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Geen bestanden' });
  const { category_id } = req.body;
  try {
    const [{ max_order }] = category_id
      ? await sql`SELECT COALESCE(MAX(sort_order),0)::int AS max_order FROM photos WHERE category_id = ${category_id}`
      : await sql`SELECT COALESCE(MAX(sort_order),0)::int AS max_order FROM photos`;

    const inserted = await Promise.all(req.files.map(async (file, i) => {
      const { filename, url } = await storeFile(file);
      const [row] = await sql`
        INSERT INTO photos (category_id,filename,url,sort_order)
        VALUES (${category_id||null},${filename},${url},${max_order+i+1})
        RETURNING id, filename, url`;
      return row;
    }));
    res.json(inserted);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Upload mislukt' }); }
});

app.put('/api/admin/photos/:id', auth, async (req, res) => {
  const { title, description, sort_order, category_id } = req.body;
  try {
    await sql`UPDATE photos SET title=${title||''}, description=${description||''}, sort_order=${sort_order||0}, category_id=${category_id||null} WHERE id=${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.delete('/api/admin/photos/:id', auth, async (req, res) => {
  try {
    const [photo] = await sql`SELECT * FROM photos WHERE id = ${req.params.id}`;
    if (!photo) return res.status(404).json({ error: 'Niet gevonden' });
    await deleteFile(photo);
    await sql`UPDATE categories SET cover_photo_id = NULL WHERE cover_photo_id = ${req.params.id}`;
    await sql`DELETE FROM photos WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.post('/api/admin/photos/reorder', auth, async (req, res) => {
  try {
    await Promise.all(req.body.photo_ids.map((id, i) =>
      sql`UPDATE photos SET sort_order = ${i+1} WHERE id = ${id}`));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Admin: settings ───────────────────────────────────────────────────────────
app.put('/api/admin/settings', auth, async (req, res) => {
  try {
    await Promise.all(Object.entries(req.body).map(([k, v]) =>
      sql`INSERT INTO settings (key,value) VALUES (${k},${v}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Admin: contacts ───────────────────────────────────────────────────────────
app.get('/api/admin/contacts', auth, async (req, res) => {
  try { res.json(await sql`SELECT * FROM contacts ORDER BY created_at DESC`); }
  catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.put('/api/admin/contacts/:id/read', auth, async (req, res) => {
  try { await sql`UPDATE contacts SET read = 1 WHERE id = ${req.params.id}`; res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.delete('/api/admin/contacts/:id', auth, async (req, res) => {
  try { await sql`DELETE FROM contacts WHERE id = ${req.params.id}`; res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Admin: private galleries ──────────────────────────────────────────────────
app.get('/api/admin/private-galleries', auth, async (req, res) => {
  try {
    res.json(await sql`
      SELECT g.*, COUNT(p.id)::int AS photo_count
      FROM private_galleries g LEFT JOIN private_photos p ON p.gallery_id = g.id
      GROUP BY g.id ORDER BY g.created_at DESC`);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.post('/api/admin/private-galleries', auth, async (req, res) => {
  const { name, description, password, event_date } = req.body;
  if (!name?.trim() || !password?.trim()) return res.status(400).json({ error: 'Naam en wachtwoord zijn verplicht' });
  try {
    const [row] = await sql`
      INSERT INTO private_galleries (name,description,password,event_date)
      VALUES (${name.trim()},${description||''},${password.trim()},${event_date||''})
      RETURNING id`;
    res.json({ id: row.id });
  } catch (e) {
    res.status(500).json({ error: e.message?.includes('unique') ? 'Dit wachtwoord is al in gebruik' : 'DB fout' });
  }
});

app.put('/api/admin/private-galleries/:id', auth, async (req, res) => {
  const { name, description, password, event_date } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Naam is verplicht' });
  try {
    if (password?.trim()) {
      await sql`UPDATE private_galleries SET name=${name.trim()}, description=${description||''}, password=${password.trim()}, event_date=${event_date||''} WHERE id=${req.params.id}`;
    } else {
      await sql`UPDATE private_galleries SET name=${name.trim()}, description=${description||''}, event_date=${event_date||''} WHERE id=${req.params.id}`;
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message?.includes('unique') ? 'Dit wachtwoord is al in gebruik' : 'DB fout' });
  }
});

app.delete('/api/admin/private-galleries/:id', auth, async (req, res) => {
  try {
    const photos = await sql`SELECT filename, url FROM private_photos WHERE gallery_id = ${req.params.id}`;
    await Promise.all(photos.map(deleteFile));
    await sql`DELETE FROM private_photos WHERE gallery_id = ${req.params.id}`;
    await sql`DELETE FROM private_galleries WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.get('/api/admin/private-photos', auth, async (req, res) => {
  const { gallery_id } = req.query;
  if (!gallery_id) return res.status(400).json({ error: 'gallery_id vereist' });
  try { res.json(await sql`SELECT * FROM private_photos WHERE gallery_id = ${gallery_id} ORDER BY sort_order, created_at`); }
  catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.post('/api/admin/private-photos', auth, upload.array('photos', 100), async (req, res) => {
  const { gallery_id } = req.body;
  if (!gallery_id) return res.status(400).json({ error: 'gallery_id vereist' });
  try {
    const [{ max_order }] = await sql`SELECT COALESCE(MAX(sort_order),0)::int AS max_order FROM private_photos WHERE gallery_id = ${gallery_id}`;
    const inserted = await Promise.all(req.files.map(async (file, i) => {
      const { filename, url } = await storeFile(file);
      const [row] = await sql`
        INSERT INTO private_photos (gallery_id,filename,url,sort_order)
        VALUES (${gallery_id},${filename},${url},${max_order+i+1})
        RETURNING id, filename, url`;
      return row;
    }));
    res.json(inserted);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Upload mislukt' }); }
});

app.delete('/api/admin/private-photos/:id', auth, async (req, res) => {
  try {
    const [photo] = await sql`SELECT * FROM private_photos WHERE id = ${req.params.id}`;
    if (!photo) return res.status(404).json({ error: 'Niet gevonden' });
    await deleteFile(photo);
    await sql`DELETE FROM private_photos WHERE id = ${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Private gallery (klant) ───────────────────────────────────────────────────
app.post('/api/private/login', async (req, res) => {
  const { password } = req.body;
  if (!password?.trim()) return res.status(400).json({ error: 'Vul een wachtwoord in' });
  try {
    const [gallery] = await sql`SELECT * FROM private_galleries WHERE password = ${password.trim()}`;
    if (!gallery) return res.status(401).json({ error: 'Ongeldig wachtwoord' });
    const token = jwt.sign({ galleryId: gallery.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, gallery: { id: gallery.id, name: gallery.name, description: gallery.description, event_date: gallery.event_date } });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.get('/api/private/photos', privateAuth, async (req, res) => {
  try {
    const [gallery] = await sql`SELECT id, name, description, event_date FROM private_galleries WHERE id = ${req.galleryId}`;
    if (!gallery) return res.status(404).json({ error: 'Galerij niet gevonden' });
    const photos = await sql`SELECT * FROM private_photos WHERE gallery_id = ${req.galleryId} ORDER BY sort_order, created_at`;
    res.json({ gallery, photos });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Export (Vercel) + lokale start ───────────────────────────────────────────
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🌐 Portfolio:   http://localhost:${PORT}`);
    console.log(`🔧 Admin panel: http://localhost:${PORT}/admin\n`);
  });
}
