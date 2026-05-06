require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

// Use a pre-computed hash if provided, otherwise hash the plain text password at startup
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);

// ─── Paths (persistent disk on Render mounts at /data) ───────────────────────
const DATA_DIR = process.env.RENDER ? '/data' : __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'portfolio.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    cover_photo_id INTEGER,
    sort_order INTEGER DEFAULT 0,
    visible INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER REFERENCES categories(id),
    filename TEXT NOT NULL,
    title TEXT DEFAULT '',
    description TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    phone TEXT,
    message TEXT,
    read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS private_galleries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    password TEXT NOT NULL,
    event_date TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS private_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gallery_id INTEGER REFERENCES private_galleries(id),
    filename TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    gallery_id INTEGER REFERENCES private_galleries(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default settings
const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
[
  ['site_name', 'Fotograaf'],
  ['hero_title', 'Fotograaf'],
  ['hero_subtitle', 'Elk moment verdient een perfect beeld'],
  ['about_title', 'Over Mij'],
  ['about_text', 'Welkom op mijn portfolio. Ik ben een gepassioneerde fotograaf die de mooiste momenten vastlegt.\n\nFotografie is meer dan een foto nemen — het is een emotie, een verhaal, een herinnering voor altijd.\n\n"Een foto zegt meer dan 1000 woorden"'],
  ['about_quote', 'Een foto zegt meer dan 1000 woorden'],
  ['contact_email', ''],
  ['contact_phone', ''],
  ['contact_location', 'België'],
  ['instagram_url', ''],
  ['facebook_url', ''],
].forEach(([k, v]) => seedSetting.run(k, v));

// Seed default categories
const seedCat = db.prepare('INSERT OR IGNORE INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)');
[
  ['Kinderfotografie', 'kinderfotografie', 'Kinderen vastleggen in hun meest authentieke en ontspannen momenten', 1],
  ['Portretfotografie', 'portretfotografie', 'Professionele portretfotografie die jouw persoonlijkheid weerspiegelt', 2],
  ['Fotoshoot', 'fotoshoot', 'Persoonlijke fotoshoots op maat van jouw wensen', 3],
  ['Evenementen', 'evenementen', 'Evenementen, feesten en speciale gelegenheden vastgelegd', 4],
  ['Diversen', 'diversen', 'Diverse fotografie', 5],
].forEach(args => seedCat.run(...args));

// ─── Supabase Storage ─────────────────────────────────────────────────────────
const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);
const STORAGE_BUCKET = 'photos';

async function uploadToSupabase(buffer, mimetype, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(key, buffer, { contentType: mimetype });
  if (error) throw error;
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

async function deleteFromSupabase(filename) {
  if (!filename) return;
  if (!filename.startsWith('http')) {
    const fp = path.join(uploadDir, filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return;
  }
  try {
    const url = new URL(filename);
    const key = url.pathname.split(`/object/public/${STORAGE_BUCKET}/`)[1];
    if (key) await supabase.storage.from(STORAGE_BUCKET).remove([key]);
  } catch { /* ignore */ }
}

function photoUrl(filename) {
  if (!filename) return null;
  if (filename.startsWith('http')) return filename;
  return `/uploads/${filename}`;
}

// ─── Multer (memory storage — files go to Supabase, not disk) ─────────────────
const uploadDir = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use('/uploads', express.static(uploadDir)); // legacy: serve old local files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token verlopen' });
  }
};

const privateAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.galleryId) return res.status(401).json({ error: 'Ongeldig token' });
    req.galleryId = payload.galleryId;
    next();
  } catch {
    res.status(401).json({ error: 'Sessie verlopen, log opnieuw in' });
  }
};

// ─── Public API ────────────────────────────────────────────────────────────────
app.get('/api/categories', (req, res) => {
  const cats = db.prepare(`
    SELECT c.*, p.filename AS cover_filename
    FROM categories c
    LEFT JOIN photos p ON c.cover_photo_id = p.id
    WHERE c.visible = 1
    ORDER BY c.sort_order, c.name
  `).all();

  const result = cats.map(c => {
    let cover = c.cover_filename ? photoUrl(c.cover_filename) : null;
    if (!cover) {
      const first = db.prepare('SELECT filename FROM photos WHERE category_id = ? ORDER BY sort_order, created_at LIMIT 1').get(c.id);
      cover = first ? photoUrl(first.filename) : null;
    }
    const count = db.prepare('SELECT COUNT(*) as n FROM photos WHERE category_id = ?').get(c.id).n;
    return { ...c, cover_url: cover, photo_count: count };
  });
  res.json(result);
});

app.get('/api/categories/:slug', (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE slug = ? AND visible = 1').get(req.params.slug);
  if (!cat) return res.status(404).json({ error: 'Niet gevonden' });
  res.json(cat);
});

app.get('/api/categories/:slug/photos', (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE slug = ?').get(req.params.slug);
  if (!cat) return res.status(404).json({ error: 'Niet gevonden' });
  const photos = db.prepare('SELECT * FROM photos WHERE category_id = ? ORDER BY sort_order, created_at').all(cat.id);
  res.json(photos.map(p => ({ ...p, url: photoUrl(p.filename) })));
});

app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  const obj = {};
  rows.forEach(r => (obj[r.key] = r.value));
  res.json(obj);
});

app.post('/api/contact', (req, res) => {
  const { name, email, phone, message } = req.body;
  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return res.status(400).json({ error: 'Naam, e-mail en bericht zijn verplicht' });
  }
  db.prepare('INSERT INTO contacts (name, email, phone, message) VALUES (?, ?, ?, ?)').run(name, email, phone || '', message);
  res.json({ success: true });
});

// ─── Admin API ─────────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (!bcrypt.compareSync(req.body.password || '', ADMIN_HASH)) {
    return res.status(401).json({ error: 'Verkeerd wachtwoord' });
  }
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token });
});

// Categories (admin)
app.get('/api/admin/categories', auth, (req, res) => {
  const cats = db.prepare(`
    SELECT c.*, COUNT(p.id) as photo_count
    FROM categories c
    LEFT JOIN photos p ON p.category_id = c.id
    GROUP BY c.id
    ORDER BY c.sort_order, c.name
  `).all();
  res.json(cats);
});

app.post('/api/admin/categories', auth, (req, res) => {
  const { name, description, visible } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Naam vereist' });
  const slug = name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM categories').get().m || 0;
  const info = db.prepare('INSERT INTO categories (name, slug, description, sort_order, visible) VALUES (?, ?, ?, ?, ?)').run(
    name.trim(), slug, description || '', maxOrder + 1, visible !== false ? 1 : 0
  );
  res.json({ id: info.lastInsertRowid, name: name.trim(), slug });
});

app.put('/api/admin/categories/:id', auth, (req, res) => {
  const { name, description, sort_order, visible } = req.body;
  db.prepare('UPDATE categories SET name=?, description=?, sort_order=?, visible=? WHERE id=?')
    .run(name, description, sort_order, visible ? 1 : 0, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/categories/:id', auth, async (req, res) => {
  const photos = db.prepare('SELECT filename FROM photos WHERE category_id = ?').all(req.params.id);
  await Promise.all(photos.map(p => deleteFromSupabase(p.filename)));
  db.prepare('DELETE FROM photos WHERE category_id = ?').run(req.params.id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.put('/api/admin/categories/:id/cover', auth, (req, res) => {
  db.prepare('UPDATE categories SET cover_photo_id = ? WHERE id = ?').run(req.body.photo_id, req.params.id);
  res.json({ success: true });
});

// Photos (admin)
app.get('/api/admin/photos', auth, (req, res) => {
  const { category_id } = req.query;
  const photos = category_id
    ? db.prepare('SELECT * FROM photos WHERE category_id = ? ORDER BY sort_order, created_at').all(category_id)
    : db.prepare('SELECT * FROM photos ORDER BY created_at DESC').all();
  res.json(photos.map(p => ({ ...p, url: photoUrl(p.filename) })));
});

app.post('/api/admin/photos', auth, upload.array('photos', 100), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Geen bestanden' });
  const { category_id } = req.body;
  const maxOrder = category_id
    ? (db.prepare('SELECT MAX(sort_order) as m FROM photos WHERE category_id = ?').get(category_id).m || 0)
    : 0;

  try {
    const inserted = await Promise.all(req.files.map(async (file, i) => {
      const url = await uploadToSupabase(file.buffer, file.mimetype, file.originalname);
      const info = db.prepare('INSERT INTO photos (category_id, filename, sort_order) VALUES (?, ?, ?)').run(
        category_id || null, url, maxOrder + i + 1
      );
      return { id: info.lastInsertRowid, filename: url, url };
    }));
    res.json(inserted);
  } catch (err) {
    console.error('Upload fout:', err);
    res.status(500).json({ error: 'Upload naar opslag mislukt: ' + err.message });
  }
});

app.put('/api/admin/photos/:id', auth, (req, res) => {
  const { title, description, sort_order, category_id } = req.body;
  db.prepare('UPDATE photos SET title=?, description=?, sort_order=?, category_id=? WHERE id=?')
    .run(title || '', description || '', sort_order || 0, category_id || null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/photos/:id', auth, async (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Niet gevonden' });
  await deleteFromSupabase(photo.filename);
  db.prepare('UPDATE categories SET cover_photo_id = NULL WHERE cover_photo_id = ?').run(req.params.id);
  db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/photos/reorder', auth, (req, res) => {
  const { photo_ids } = req.body;
  const update = db.prepare('UPDATE photos SET sort_order = ? WHERE id = ?');
  photo_ids.forEach((id, i) => update.run(i + 1, id));
  res.json({ success: true });
});

// Settings (admin)
app.put('/api/admin/settings', auth, (req, res) => {
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  Object.entries(req.body).forEach(([k, v]) => upsert.run(k, v));
  res.json({ success: true });
});

// Contacts (admin)
app.get('/api/admin/contacts', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM contacts ORDER BY created_at DESC').all());
});

app.put('/api/admin/contacts/:id/read', auth, (req, res) => {
  db.prepare('UPDATE contacts SET read = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/contacts/:id', auth, (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Private gallery (client-facing) ──────────────────────────────────────────
app.get('/prive', (req, res) => res.sendFile(path.join(__dirname, 'public', 'prive.html')));

app.post('/api/private/login', (req, res) => {
  const { email, password } = req.body;
  if (!password?.trim()) return res.status(400).json({ error: 'Vul je wachtwoord in' });

  if (email?.trim()) {
    const client = db.prepare('SELECT * FROM clients WHERE email = ?').get(email.trim().toLowerCase());
    if (!client || !bcrypt.compareSync(password.trim(), client.password_hash)) {
      return res.status(401).json({ error: 'Ongeldig e-mailadres of wachtwoord' });
    }
    const gallery = db.prepare('SELECT id, name, description, event_date FROM private_galleries WHERE id = ?').get(client.gallery_id);
    if (!gallery) return res.status(401).json({ error: 'Galerij niet gevonden' });
    const token = jwt.sign({ galleryId: gallery.id }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token, gallery });
  }

  // Fallback: old gallery-password login (backward compat)
  const gallery = db.prepare('SELECT * FROM private_galleries WHERE password = ?').get(password.trim());
  if (!gallery) return res.status(401).json({ error: 'Ongeldig wachtwoord' });
  const token = jwt.sign({ galleryId: gallery.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, gallery: { id: gallery.id, name: gallery.name, description: gallery.description, event_date: gallery.event_date } });
});

app.get('/api/private/photos', privateAuth, (req, res) => {
  const gallery = db.prepare('SELECT id, name, description, event_date FROM private_galleries WHERE id = ?').get(req.galleryId);
  if (!gallery) return res.status(404).json({ error: 'Galerij niet gevonden' });
  const photos = db.prepare('SELECT * FROM private_photos WHERE gallery_id = ? ORDER BY sort_order, created_at').all(req.galleryId);
  res.json({ gallery, photos: photos.map(p => ({ ...p, url: photoUrl(p.filename) })) });
});

// ─── Admin: private galleries ──────────────────────────────────────────────────
app.get('/api/admin/private-galleries', auth, (req, res) => {
  const galleries = db.prepare(`
    SELECT g.*, COUNT(p.id) AS photo_count
    FROM private_galleries g
    LEFT JOIN private_photos p ON p.gallery_id = g.id
    GROUP BY g.id
    ORDER BY g.created_at DESC
  `).all();
  res.json(galleries);
});

app.post('/api/admin/private-galleries', auth, (req, res) => {
  const { name, description, password, event_date } = req.body;
  if (!name?.trim() || !password?.trim()) return res.status(400).json({ error: 'Naam en wachtwoord zijn verplicht' });

  const exists = db.prepare('SELECT id FROM private_galleries WHERE password = ?').get(password.trim());
  if (exists) return res.status(400).json({ error: 'Dit wachtwoord is al in gebruik' });

  const info = db.prepare('INSERT INTO private_galleries (name, description, password, event_date) VALUES (?, ?, ?, ?)')
    .run(name.trim(), description || '', password.trim(), event_date || '');
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/admin/private-galleries/:id', auth, (req, res) => {
  const { name, description, password, event_date } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Naam is verplicht' });

  if (password?.trim()) {
    const exists = db.prepare('SELECT id FROM private_galleries WHERE password = ? AND id != ?').get(password.trim(), req.params.id);
    if (exists) return res.status(400).json({ error: 'Dit wachtwoord is al in gebruik' });
    db.prepare('UPDATE private_galleries SET name=?, description=?, password=?, event_date=? WHERE id=?')
      .run(name.trim(), description || '', password.trim(), event_date || '', req.params.id);
  } else {
    db.prepare('UPDATE private_galleries SET name=?, description=?, event_date=? WHERE id=?')
      .run(name.trim(), description || '', event_date || '', req.params.id);
  }
  res.json({ success: true });
});

app.delete('/api/admin/private-galleries/:id', auth, async (req, res) => {
  const photos = db.prepare('SELECT filename FROM private_photos WHERE gallery_id = ?').all(req.params.id);
  await Promise.all(photos.map(p => deleteFromSupabase(p.filename)));
  db.prepare('DELETE FROM private_photos WHERE gallery_id = ?').run(req.params.id);
  db.prepare('DELETE FROM private_galleries WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/private-photos', auth, (req, res) => {
  const { gallery_id } = req.query;
  if (!gallery_id) return res.status(400).json({ error: 'gallery_id vereist' });
  const photos = db.prepare('SELECT * FROM private_photos WHERE gallery_id = ? ORDER BY sort_order, created_at').all(gallery_id);
  res.json(photos.map(p => ({ ...p, url: photoUrl(p.filename) })));
});

app.post('/api/admin/private-photos', auth, upload.array('photos', 100), async (req, res) => {
  const { gallery_id } = req.body;
  if (!gallery_id) return res.status(400).json({ error: 'gallery_id vereist' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM private_photos WHERE gallery_id = ?').get(gallery_id).m || 0;
  try {
    const inserted = await Promise.all(req.files.map(async (file, i) => {
      const url = await uploadToSupabase(file.buffer, file.mimetype, file.originalname);
      const info = db.prepare('INSERT INTO private_photos (gallery_id, filename, sort_order) VALUES (?, ?, ?)').run(gallery_id, url, maxOrder + i + 1);
      return { id: info.lastInsertRowid, filename: url, url };
    }));
    res.json(inserted);
  } catch (err) {
    console.error('Upload fout:', err);
    res.status(500).json({ error: 'Upload naar opslag mislukt: ' + err.message });
  }
});

app.delete('/api/admin/private-photos/:id', auth, async (req, res) => {
  const photo = db.prepare('SELECT * FROM private_photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Niet gevonden' });
  await deleteFromSupabase(photo.filename);
  db.prepare('DELETE FROM private_photos WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Client accounts ──────────────────────────────────────────────────────────
app.get('/api/admin/clients', auth, (req, res) => {
  const { gallery_id } = req.query;
  if (!gallery_id) return res.status(400).json({ error: 'gallery_id vereist' });
  const clients = db.prepare('SELECT id, name, email, created_at FROM clients WHERE gallery_id = ? ORDER BY created_at').all(gallery_id);
  res.json(clients);
});

app.post('/api/admin/clients', auth, (req, res) => {
  const { name, email, gallery_id } = req.body;
  if (!name?.trim() || !email?.trim() || !gallery_id) {
    return res.status(400).json({ error: 'Naam, e-mail en galerij zijn verplicht' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM clients WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(400).json({ error: 'Dit e-mailadres is al in gebruik' });

  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const plainPassword = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const hash = bcrypt.hashSync(plainPassword, 10);

  const info = db.prepare('INSERT INTO clients (name, email, password_hash, gallery_id) VALUES (?, ?, ?, ?)').run(name.trim(), normalizedEmail, hash, gallery_id);
  res.json({ id: info.lastInsertRowid, name: name.trim(), email: normalizedEmail, password: plainPassword });
});

app.put('/api/admin/clients/:id/reset-password', auth, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Niet gevonden' });
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const plainPassword = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  db.prepare('UPDATE clients SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(plainPassword, 10), req.params.id);
  res.json({ password: plainPassword });
});

app.delete('/api/admin/clients/:id', auth, (req, res) => {
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌐 Portfolio:   http://localhost:${PORT}`);
  console.log(`🔧 Admin panel: http://localhost:${PORT}/admin`);
  console.log('\nWijzig het wachtwoord in het .env bestand!\n');
});
