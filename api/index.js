require('dotenv').config();
const express = require('express');
const postgres = require('postgres');
const { del } = require('@vercel/blob');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const IS_VERCEL = !!process.env.VERCEL;

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);

const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 20, connect_timeout: 10, ssl: 'require' });

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);
const STORAGE_BUCKET = 'photos';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ADMIN_DIR  = path.join(__dirname, '..', 'admin');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

if (!IS_VERCEL && !fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── File delete (supports Vercel Blob + Supabase Storage) ────────────────────
async function deleteFile(photo) {
  try {
    const url = photo.url || '';
    if (url.includes('vercel-blob') || url.includes('public.blob.vercel')) {
      await del(url);
    } else if (url.startsWith('http') && url.includes('supabase')) {
      const key = url.split(`/object/public/${STORAGE_BUCKET}/`)[1];
      if (key) await supabase.storage.from(STORAGE_BUCKET).remove([key]);
    }
  } catch (e) {
    console.error('deleteFile:', e.message);
  }
}

// ─── DB init ───────────────────────────────────────────────────────────────────
// Bump this when the schema or seed data changes so migrations re-run once.
const DB_VERSION = '3';

async function initDB() {
  // Batch 1: tables with no foreign-key deps (run in parallel)
  await Promise.all([
    sql`CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '', cover_photo_id INTEGER,
      sort_order INTEGER DEFAULT 0, visible INTEGER DEFAULT 1,
      parent_id INTEGER, event_date TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW()
    )`,
    sql`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`,
    sql`CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY, name TEXT, email TEXT, phone TEXT, message TEXT,
      read INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW()
    )`,
    sql`CREATE TABLE IF NOT EXISTS private_galleries (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
      password TEXT NOT NULL DEFAULT '', event_date TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )`,
  ]);

  // Batch 2: tables that reference batch-1 tables (run in parallel)
  await Promise.all([
    sql`CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY, category_id INTEGER REFERENCES categories(id),
      filename TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
      title TEXT DEFAULT '', description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW()
    )`,
    sql`CREATE TABLE IF NOT EXISTS private_photos (
      id SERIAL PRIMARY KEY, gallery_id INTEGER REFERENCES private_galleries(id),
      filename TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
      sort_order INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW()
    )`,
    sql`CREATE TABLE IF NOT EXISTS user_gallery_links (
      id SERIAL PRIMARY KEY,
      supabase_user_id TEXT UNIQUE NOT NULL,
      gallery_id INTEGER REFERENCES private_galleries(id) ON DELETE CASCADE,
      email TEXT NOT NULL, name TEXT, created_at TIMESTAMP DEFAULT NOW()
    )`,
  ]);

  // Skip the rest if this version's migrations already ran
  const [ver] = await sql`SELECT value FROM settings WHERE key = 'db_version'`;
  if (ver?.value === DB_VERSION) return;

  // Migrations + seed data (only runs once per DB_VERSION)
  await Promise.all([
    sql`ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INTEGER`,
    sql`ALTER TABLE categories ADD COLUMN IF NOT EXISTS event_date TEXT DEFAULT ''`,
  ]);

  await Promise.all([
    ...([
      ['site_name',       'Arnoud Bex'],
      ['hero_title',      'Arnoud Bex'],
      ['hero_subtitle',   'Elk moment verdient een perfect beeld'],
      ['about_title',     'Over Mij'],
      ['about_text',      'Welkom op mijn portfolio. Ik ben een gepassioneerde fotograaf die de mooiste momenten vastlegt.\n\nFotografie is meer dan een foto nemen — het is een emotie, een verhaal, een herinnering voor altijd.'],
      ['about_quote',     'Een foto zegt meer dan 1000 woorden'],
      ['contact_email',   ''],
      ['contact_phone',   ''],
      ['contact_location','België'],
      ['instagram_url',   ''],
      ['facebook_url',    ''],
    ].map(([k, v]) => sql`INSERT INTO settings (key,value) VALUES (${k},${v}) ON CONFLICT (key) DO NOTHING`)),
    ...([
      ['Kinderfotografie',  'kinderfotografie',  'Kinderen vastleggen in hun meest authentieke en ontspannen momenten', 1],
      ['Portretfotografie', 'portretfotografie', 'Professionele portretfotografie die jouw persoonlijkheid weerspiegelt', 2],
      ['Fotoshoot',         'fotoshoot',         'Persoonlijke fotoshoots op maat van jouw wensen', 3],
      ['Evenementen',       'evenementen',       'Evenementen, feesten en speciale gelegenheden vastgelegd', 4],
      ['Diversen',          'diversen',          'Diverse fotografie', 5],
    ].map(([name, slug, desc, order]) =>
      sql`INSERT INTO categories (name,slug,description,sort_order) VALUES (${name},${slug},${desc},${order}) ON CONFLICT (slug) DO NOTHING`
    )),
  ]);

  await sql`INSERT INTO settings (key,value) VALUES ('db_version',${DB_VERSION}) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`;
}

// ─── Middleware ────────────────────────────────────────────────────────────────
// Start DB init immediately at module load so it runs in parallel with
// any incoming request, rather than blocking the first request entirely.
const dbReady = initDB().catch(e => { console.error('DB init failed:', e); });

app.use(async (req, res, next) => {
  try { await dbReady; next(); } catch (e) {
    res.status(500).json({ error: 'Database niet beschikbaar' });
  }
});

app.use(express.json());
if (!IS_VERCEL) app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));
app.use('/admin', express.static(ADMIN_DIR));
app.get('/prive', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'prive.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(ADMIN_DIR, 'index.html')));

// ─── Auth middleware ───────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token verlopen' }); }
};

const privateAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });

  // Try Supabase Auth token first
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (!error && user) {
      const [link] = await sql`SELECT gallery_id FROM user_gallery_links WHERE supabase_user_id = ${user.id}`;
      if (!link) return res.status(403).json({ error: 'Geen galerij gekoppeld. Neem contact op met de fotograaf.', code: 'NO_GALLERY' });
      req.galleryId = link.gallery_id;
      return next();
    }
  } catch {}

  // Fallback: legacy custom JWT (old gallery-password login)
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (!p.galleryId) return res.status(401).json({ error: 'Ongeldig token' });
    req.galleryId = p.galleryId;
    return next();
  } catch {
    res.status(401).json({ error: 'Sessie verlopen, log opnieuw in' });
  }
};

// ─── Public API ────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY });
});

app.get('/api/categories', async (req, res) => {
  try {
    const cats = await sql`
      SELECT c.*,
        COALESCE(cp.url, (SELECT url FROM photos WHERE category_id = c.id ORDER BY sort_order, created_at LIMIT 1)) AS cover_url,
        (SELECT COUNT(*)::int FROM photos WHERE category_id = c.id) AS photo_count
      FROM categories c
      LEFT JOIN photos cp ON c.cover_photo_id = cp.id
      WHERE c.visible = 1 AND c.parent_id IS NULL
      ORDER BY c.sort_order, c.name`;
    res.json(cats);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.get('/api/categories/:slug', async (req, res) => {
  try {
    const [cat] = await sql`
      SELECT c.*, pc.slug AS parent_slug, pc.name AS parent_name
      FROM categories c LEFT JOIN categories pc ON c.parent_id = pc.id
      WHERE c.slug = ${req.params.slug} AND c.visible = 1`;
    if (!cat) return res.status(404).json({ error: 'Niet gevonden' });
    res.json(cat);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.get('/api/categories/:slug/subcategories', async (req, res) => {
  try {
    const [cat] = await sql`SELECT id FROM categories WHERE slug = ${req.params.slug}`;
    if (!cat) return res.status(404).json({ error: 'Niet gevonden' });
    const subcats = await sql`
      SELECT c.*,
        COALESCE(cp.url, (SELECT url FROM photos WHERE category_id = c.id ORDER BY sort_order, created_at LIMIT 1)) AS cover_url,
        (SELECT COUNT(*)::int FROM photos WHERE category_id = c.id) AS photo_count
      FROM categories c LEFT JOIN photos cp ON c.cover_photo_id = cp.id
      WHERE c.parent_id = ${cat.id} AND c.visible = 1
      ORDER BY c.sort_order, c.name`;
    res.json(subcats);
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
    const { parent_id } = req.query;
    if (parent_id !== undefined) {
      res.json(await sql`
        SELECT c.*,
          COALESCE(cp.url,(SELECT url FROM photos WHERE category_id=c.id ORDER BY sort_order,created_at LIMIT 1)) AS cover_url,
          COUNT(p.id)::int AS photo_count
        FROM categories c LEFT JOIN photos cp ON c.cover_photo_id=cp.id LEFT JOIN photos p ON p.category_id=c.id
        WHERE c.parent_id=${parent_id} GROUP BY c.id,cp.url ORDER BY c.sort_order,c.name`);
    } else {
      res.json(await sql`
        SELECT c.*, COUNT(p.id)::int AS photo_count
        FROM categories c LEFT JOIN photos p ON p.category_id=c.id
        GROUP BY c.id ORDER BY c.sort_order,c.name`);
    }
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.post('/api/admin/categories', auth, async (req, res) => {
  const { name, description, visible, parent_id, event_date } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Naam vereist' });
  const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    const [{ count }] = await sql`SELECT COUNT(*)::int as count FROM categories`;
    const [row] = await sql`
      INSERT INTO categories (name,slug,description,sort_order,visible,parent_id,event_date)
      VALUES (${name.trim()},${slug},${description||''},${count+1},${visible!==false?1:0},${parent_id||null},${event_date||''})
      RETURNING id,slug`;
    res.json({ id: row.id, name: name.trim(), slug: row.slug });
  } catch (e) {
    res.status(500).json({ error: e.message?.includes('unique') ? 'Naam al in gebruik' : 'DB fout' });
  }
});

app.put('/api/admin/categories/:id', auth, async (req, res) => {
  const { name, description, sort_order, visible, parent_id, event_date } = req.body;
  try {
    await sql`UPDATE categories SET name=${name},description=${description},sort_order=${sort_order},visible=${visible?1:0},parent_id=${parent_id||null},event_date=${event_date||''} WHERE id=${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.delete('/api/admin/categories/:id', auth, async (req, res) => {
  try {
    const photos = await sql`SELECT filename,url FROM photos WHERE category_id=${req.params.id}`;
    await Promise.all(photos.map(deleteFile));
    await sql`DELETE FROM photos WHERE category_id=${req.params.id}`;
    await sql`DELETE FROM categories WHERE id=${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.put('/api/admin/categories/:id/cover', auth, async (req, res) => {
  try {
    await sql`UPDATE categories SET cover_photo_id=${req.body.photo_id} WHERE id=${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Admin: photos (direct upload via Supabase signed URLs) ───────────────────
app.post('/api/admin/upload-url', auth, async (req, res) => {
  const { filename, mimetype } = req.body;
  if (!filename || !mimetype) return res.status(400).json({ error: 'filename en mimetype vereist' });
  const ext = path.extname(filename).toLowerCase();
  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUploadUrl(key);
  if (error) return res.status(500).json({ error: error.message });
  const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(key);
  res.json({ signedUrl: data.signedUrl, publicUrl: urlData.publicUrl });
});

app.get('/api/admin/photos', auth, async (req, res) => {
  try {
    const { category_id } = req.query;
    res.json(category_id
      ? await sql`SELECT * FROM photos WHERE category_id=${category_id} ORDER BY sort_order,created_at`
      : await sql`SELECT * FROM photos ORDER BY created_at DESC`);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.post('/api/admin/photos', auth, async (req, res) => {
  const { category_id, urls } = req.body;
  if (!urls?.length) return res.status(400).json({ error: 'Geen URLs' });
  try {
    const [{ max_order }] = category_id
      ? await sql`SELECT COALESCE(MAX(sort_order),0)::int AS max_order FROM photos WHERE category_id=${category_id}`
      : await sql`SELECT COALESCE(MAX(sort_order),0)::int AS max_order FROM photos`;
    const inserted = await Promise.all(urls.map(async (url, i) => {
      const [row] = await sql`INSERT INTO photos (category_id,filename,url,sort_order) VALUES (${category_id||null},${url},${url},${max_order+i+1}) RETURNING id,filename,url`;
      return row;
    }));
    res.json(inserted);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.put('/api/admin/photos/:id', auth, async (req, res) => {
  const { title, description, sort_order, category_id } = req.body;
  try {
    await sql`UPDATE photos SET title=${title||''},description=${description||''},sort_order=${sort_order||0},category_id=${category_id||null} WHERE id=${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.delete('/api/admin/photos/:id', auth, async (req, res) => {
  try {
    const [photo] = await sql`SELECT * FROM photos WHERE id=${req.params.id}`;
    if (!photo) return res.status(404).json({ error: 'Niet gevonden' });
    await deleteFile(photo);
    await sql`UPDATE categories SET cover_photo_id=NULL WHERE cover_photo_id=${req.params.id}`;
    await sql`DELETE FROM photos WHERE id=${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.post('/api/admin/photos/reorder', auth, async (req, res) => {
  try {
    await Promise.all(req.body.photo_ids.map((id, i) => sql`UPDATE photos SET sort_order=${i+1} WHERE id=${id}`));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Admin: settings ───────────────────────────────────────────────────────────
app.put('/api/admin/settings', auth, async (req, res) => {
  try {
    await Promise.all(Object.entries(req.body).map(([k, v]) =>
      sql`INSERT INTO settings (key,value) VALUES (${k},${v}) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Admin: contacts ───────────────────────────────────────────────────────────
app.get('/api/admin/contacts', auth, async (req, res) => {
  try { res.json(await sql`SELECT * FROM contacts ORDER BY created_at DESC`); }
  catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.put('/api/admin/contacts/:id/read', auth, async (req, res) => {
  try { await sql`UPDATE contacts SET read=1 WHERE id=${req.params.id}`; res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.delete('/api/admin/contacts/:id', auth, async (req, res) => {
  try { await sql`DELETE FROM contacts WHERE id=${req.params.id}`; res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Admin: private galleries ──────────────────────────────────────────────────
app.get('/api/admin/private-galleries', auth, async (req, res) => {
  try {
    res.json(await sql`
      SELECT g.*, COUNT(p.id)::int AS photo_count
      FROM private_galleries g LEFT JOIN private_photos p ON p.gallery_id=g.id
      GROUP BY g.id ORDER BY g.created_at DESC`);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.post('/api/admin/private-galleries', auth, async (req, res) => {
  const { name, description, event_date } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Naam is verplicht' });
  const password = Math.random().toString(36).slice(2, 10); // random, not used for login
  try {
    const [row] = await sql`INSERT INTO private_galleries (name,description,password,event_date) VALUES (${name.trim()},${description||''},${password},${event_date||''}) RETURNING id`;
    res.json({ id: row.id });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.put('/api/admin/private-galleries/:id', auth, async (req, res) => {
  const { name, description, event_date } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Naam is verplicht' });
  try {
    await sql`UPDATE private_galleries SET name=${name.trim()},description=${description||''},event_date=${event_date||''} WHERE id=${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.delete('/api/admin/private-galleries/:id', auth, async (req, res) => {
  try {
    const photos = await sql`SELECT filename,url FROM private_photos WHERE gallery_id=${req.params.id}`;
    await Promise.all(photos.map(deleteFile));
    await sql`DELETE FROM private_photos WHERE gallery_id=${req.params.id}`;
    await sql`DELETE FROM user_gallery_links WHERE gallery_id=${req.params.id}`;
    await sql`DELETE FROM private_galleries WHERE id=${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.get('/api/admin/private-photos', auth, async (req, res) => {
  const { gallery_id } = req.query;
  if (!gallery_id) return res.status(400).json({ error: 'gallery_id vereist' });
  try { res.json(await sql`SELECT * FROM private_photos WHERE gallery_id=${gallery_id} ORDER BY sort_order,created_at`); }
  catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.post('/api/admin/private-photos', auth, async (req, res) => {
  const { gallery_id, urls } = req.body;
  if (!gallery_id) return res.status(400).json({ error: 'gallery_id vereist' });
  if (!urls?.length) return res.status(400).json({ error: 'Geen URLs' });
  try {
    const [{ max_order }] = await sql`SELECT COALESCE(MAX(sort_order),0)::int AS max_order FROM private_photos WHERE gallery_id=${gallery_id}`;
    const inserted = await Promise.all(urls.map(async (url, i) => {
      const [row] = await sql`INSERT INTO private_photos (gallery_id,filename,url,sort_order) VALUES (${gallery_id},${url},${url},${max_order+i+1}) RETURNING id,filename,url`;
      return row;
    }));
    res.json(inserted);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.delete('/api/admin/private-photos/:id', auth, async (req, res) => {
  try {
    const [photo] = await sql`SELECT * FROM private_photos WHERE id=${req.params.id}`;
    if (!photo) return res.status(404).json({ error: 'Niet gevonden' });
    await deleteFile(photo);
    await sql`DELETE FROM private_photos WHERE id=${req.params.id}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Admin: user-gallery linking ───────────────────────────────────────────────
app.get('/api/admin/gallery-users/:galleryId', auth, async (req, res) => {
  try {
    res.json(await sql`SELECT * FROM user_gallery_links WHERE gallery_id=${req.params.galleryId} ORDER BY name`);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.post('/api/admin/user-gallery-link', auth, async (req, res) => {
  const { email, gallery_id } = req.body;
  if (!email?.trim() || !gallery_id) return res.status(400).json({ error: 'email en gallery_id vereist' });

  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (error) return res.status(500).json({ error: error.message });

  const user = data.users.find(u => u.email?.toLowerCase() === email.trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'Geen geregistreerd account gevonden met dit e-mailadres' });

  const name = user.user_metadata?.name || user.email;
  try {
    await sql`
      INSERT INTO user_gallery_links (supabase_user_id,gallery_id,email,name)
      VALUES (${user.id},${gallery_id},${user.email},${name})
      ON CONFLICT (supabase_user_id) DO UPDATE SET gallery_id=EXCLUDED.gallery_id, email=EXCLUDED.email, name=EXCLUDED.name`;
    res.json({ success: true, supabase_user_id: user.id, email: user.email, name });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.delete('/api/admin/user-gallery-link/:userId', auth, async (req, res) => {
  try {
    await sql`DELETE FROM user_gallery_links WHERE supabase_user_id=${req.params.userId}`;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

app.get('/api/admin/unlinked-users', auth, async (req, res) => {
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (error) return res.status(500).json({ error: error.message });
  try {
    const linked = await sql`SELECT supabase_user_id FROM user_gallery_links`;
    const linkedIds = new Set(linked.map(r => r.supabase_user_id));
    const unlinked = data.users
      .filter(u => u.email_confirmed_at && !linkedIds.has(u.id))
      .map(u => ({ id: u.id, email: u.email, name: u.user_metadata?.name, created_at: u.created_at }));
    res.json(unlinked);
  } catch (e) { res.status(500).json({ error: 'DB fout' }); }
});

// ─── Private gallery (klant) ───────────────────────────────────────────────────
app.get('/api/private/photos', privateAuth, async (req, res) => {
  try {
    const [gallery] = await sql`SELECT id,name,description,event_date FROM private_galleries WHERE id=${req.galleryId}`;
    if (!gallery) return res.status(404).json({ error: 'Galerij niet gevonden' });
    const photos = await sql`SELECT * FROM private_photos WHERE gallery_id=${req.galleryId} ORDER BY sort_order,created_at`;
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
