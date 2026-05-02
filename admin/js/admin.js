// ── Auth ──────────────────────────────────────────────────────────────────────
let token = localStorage.getItem('admin_token');

function authHeaders() {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function api(method, url, body) {
  const opts = { method, headers: authHeaders() };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (res.status === 401) { logout(); return null; }
  return res.json().catch(() => null);
}

async function apiUpload(url, formData) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  if (res.status === 401) { logout(); return null; }
  return res.json();
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (token) {
    showApp();
  } else {
    document.getElementById('login-screen').style.display = 'flex';
  }

  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const password = document.getElementById('password').value;
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      const data = await res.json();
      token = data.token;
      localStorage.setItem('admin_token', token);
      showApp();
    } else {
      document.getElementById('login-error').textContent = 'Verkeerd wachtwoord.';
    }
  });

  document.getElementById('logout-btn').addEventListener('click', logout);
});

function logout() {
  localStorage.removeItem('admin_token');
  token = null;
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-error').textContent = '';
  document.getElementById('password').value = '';
}

async function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  initNav();
  await loadDashboard();
  initQuickUpload();
  initPhotosPage();
  initCategoriesPage();
  initSettingsPage();
  initEventsPage();
  initPrivatePage();
  await loadMessages();
}

// ── Navigation ────────────────────────────────────────────────────────────────
function initNav() {
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });
}

function switchPage(page) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page-content').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));

  const titles = { dashboard: 'Dashboard', photos: "Foto's", categories: 'Categorieën', settings: 'Instellingen', events: 'Evenementen', private: 'Privé Galerijen', messages: 'Berichten' };
  document.getElementById('page-title').textContent = titles[page] || page;

  if (page === 'photos') refreshPhotosPage();
  if (page === 'categories') refreshCategories();
  if (page === 'events') loadEvents();
  if (page === 'private') loadPrivateGalleries();
  if (page === 'messages') loadMessages();
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show${isError ? ' error' : ''}`;
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  const [cats, msgs] = await Promise.all([
    api('GET', '/api/admin/categories'),
    api('GET', '/api/admin/contacts'),
  ]);

  const totalPhotos = cats?.reduce((s, c) => s + (c.photo_count || 0), 0) || 0;
  const unread = msgs?.filter(m => !m.read).length || 0;

  document.getElementById('stats').innerHTML = `
    <div class="stat-card"><div class="stat-val">${cats?.length || 0}</div><div class="stat-label">Categorieën</div></div>
    <div class="stat-card"><div class="stat-val">${totalPhotos}</div><div class="stat-label">Foto's</div></div>
    <div class="stat-card"><div class="stat-val">${msgs?.length || 0}</div><div class="stat-label">Berichten</div></div>
    <div class="stat-card"><div class="stat-val">${unread}</div><div class="stat-label">Ongelezen</div></div>
  `;

  if (unread > 0) {
    const badge = document.getElementById('msg-badge');
    badge.textContent = unread;
    badge.style.display = '';
  }

  // Populate quick-upload category select
  const sel = document.getElementById('quick-cat-select');
  sel.innerHTML = '<option value="">— Kies categorie —</option>' +
    (cats || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');

  // Also populate photos-page filter
  const photoSel = document.getElementById('photos-cat-filter');
  photoSel.innerHTML = '<option value="">— Kies categorie —</option>' +
    (cats || []).map(c => `<option value="${c.id}">${c.name} (${c.photo_count})</option>`).join('');
}

// ── Quick Upload ──────────────────────────────────────────────────────────────
function initQuickUpload() {
  const zone = document.getElementById('quick-upload-zone');
  const input = document.getElementById('quick-file-input');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    uploadFiles([...e.dataTransfer.files], document.getElementById('quick-cat-select').value);
  });
  input.addEventListener('change', () => {
    uploadFiles([...input.files], document.getElementById('quick-cat-select').value);
    input.value = '';
  });
}

async function uploadFiles(files, categoryId) {
  if (!files.length) return;
  if (!categoryId) { toast('Kies eerst een categorie', true); return; }

  const progressEl = document.getElementById('upload-progress');
  progressEl.innerHTML = '';

  const fd = new FormData();
  fd.append('category_id', categoryId);
  files.forEach(f => {
    fd.append('photos', f);
    progressEl.innerHTML += `
      <div class="progress-item" id="prog-${f.name.replace(/\W/g, '')}">
        <span style="flex:0 0 150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.name}</span>
        <div class="progress-bar-wrap"><div class="progress-bar" style="width:0%"></div></div>
        <span style="flex:0 0 60px;text-align:right;color:var(--gray)">0%</span>
      </div>`;
  });

  // Simulate upload progress then do actual upload
  const progressBars = progressEl.querySelectorAll('.progress-bar');
  const progressTexts = progressEl.querySelectorAll('.progress-item span:last-child');

  let progress = 0;
  const interval = setInterval(() => {
    progress = Math.min(progress + Math.random() * 20, 85);
    progressBars.forEach(b => b.style.width = progress + '%');
    progressTexts.forEach(t => t.textContent = Math.round(progress) + '%');
  }, 200);

  const result = await apiUpload('/api/admin/photos', fd);

  clearInterval(interval);
  progressBars.forEach(b => b.style.width = '100%');
  progressTexts.forEach(t => t.textContent = '100%');

  if (result?.length) {
    toast(`${result.length} foto${result.length !== 1 ? "'s" : ''} geüpload!`);
    setTimeout(() => progressEl.innerHTML = '', 2000);
    await loadDashboard();
  } else {
    toast('Upload mislukt', true);
    setTimeout(() => progressEl.innerHTML = '', 3000);
  }
}

// ── Photos page ───────────────────────────────────────────────────────────────
function initPhotosPage() {
  const filter = document.getElementById('photos-cat-filter');
  filter.addEventListener('change', () => refreshPhotosPage());

  const uploadBtn = document.getElementById('photos-upload-btn');
  const fileInput = document.getElementById('photos-file-input');
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    uploadFiles([...fileInput.files], filter.value);
    fileInput.value = '';
  });
}

async function refreshPhotosPage() {
  const catId = document.getElementById('photos-cat-filter').value;
  const grid = document.getElementById('photos-grid');

  if (!catId) {
    grid.innerHTML = '<p style="color:var(--gray);padding:2rem;grid-column:1/-1">Selecteer een categorie.</p>';
    return;
  }

  grid.innerHTML = '<p style="color:var(--gray);padding:1rem;grid-column:1/-1">Laden...</p>';
  const photos = await api('GET', `/api/admin/photos?category_id=${catId}`);
  const cats = await api('GET', '/api/admin/categories');
  const cat = cats?.find(c => c.id === +catId);

  if (!photos?.length) {
    grid.innerHTML = '<p style="color:var(--gray);padding:2rem;grid-column:1/-1">Geen foto\'s in deze categorie.</p>';
    return;
  }

  grid.innerHTML = photos.map(p => `
    <div class="photo-thumb" data-id="${p.id}">
      <img src="${p.url || '/uploads/' + p.filename}" alt="${p.title || ''}">
      ${cat?.cover_photo_id === p.id ? '<span class="photo-cover-badge">Cover</span>' : ''}
      <div class="photo-thumb-actions">
        <button class="btn-cover" data-id="${p.id}">Als cover</button>
        <button class="btn-del" data-id="${p.id}">Verwijderen</button>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.btn-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Foto verwijderen?')) return;
      await api('DELETE', `/api/admin/photos/${btn.dataset.id}`);
      toast('Foto verwijderd');
      refreshPhotosPage();
      loadDashboard();
    });
  });

  grid.querySelectorAll('.btn-cover').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api('PUT', `/api/admin/categories/${catId}/cover`, { photo_id: +btn.dataset.id });
      toast('Coverfoto ingesteld');
      refreshPhotosPage();
    });
  });
}

// ── Categories page ───────────────────────────────────────────────────────────
function initCategoriesPage() {
  document.getElementById('new-cat-btn').addEventListener('click', () => openCatModal());
  document.getElementById('cat-modal-cancel').addEventListener('click', closeCatModal);
  document.getElementById('cat-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('cat-modal')) closeCatModal();
  });
  document.getElementById('cat-form').addEventListener('submit', saveCat);
}

async function refreshCategories() {
  const list = document.getElementById('cat-list');
  list.innerHTML = '<p style="color:var(--gray);padding:1rem">Laden...</p>';
  const allCats = await api('GET', '/api/admin/categories');
  const cats = allCats?.filter(c => !c.parent_id);

  if (!cats?.length) {
    list.innerHTML = '<p style="color:var(--gray);padding:1rem">Nog geen categorieën.</p>';
    return;
  }

  list.innerHTML = cats.map(c => `
    <div class="cat-row" data-id="${c.id}">
      <div>
        <div class="cat-row-name">${c.name} ${!c.visible ? '<span style="color:#aaa;font-size:.75rem">(verborgen)</span>' : ''}</div>
        <div class="cat-row-slug">/gallery.html?slug=${c.slug}</div>
      </div>
      <div class="cat-row-count">${c.photo_count} foto${c.photo_count !== 1 ? "'s" : ''}</div>
      <div class="cat-row-actions">
        <button class="btn btn-outline btn-sm btn-edit" data-id="${c.id}">Bewerken</button>
        <button class="btn btn-danger btn-sm btn-del-cat" data-id="${c.id}">Verwijderen</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cat = cats.find(c => c.id === +btn.dataset.id);
      openCatModal(cat);
    });
  });

  list.querySelectorAll('.btn-del-cat').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cat = cats.find(c => c.id === +btn.dataset.id);
      if (!confirm(`Categorie "${cat.name}" en alle bijbehorende foto's verwijderen?`)) return;
      await api('DELETE', `/api/admin/categories/${btn.dataset.id}`);
      toast('Categorie verwijderd');
      refreshCategories();
      loadDashboard();
    });
  });
}

function openCatModal(cat = null) {
  const form = document.getElementById('cat-form');
  form.reset();
  document.getElementById('cat-modal-title').textContent = cat ? 'Categorie bewerken' : 'Categorie toevoegen';
  if (cat) {
    form.elements.id.value = cat.id;
    form.elements.name.value = cat.name;
    form.elements.description.value = cat.description || '';
    form.elements.sort_order.value = cat.sort_order;
    form.elements.visible.checked = !!cat.visible;
  }
  document.getElementById('cat-modal').classList.add('open');
  form.elements.name.focus();
}

function closeCatModal() {
  document.getElementById('cat-modal').classList.remove('open');
}

async function saveCat(e) {
  e.preventDefault();
  const form = e.target;
  const id = form.elements.id.value;
  const body = {
    name: form.elements.name.value,
    description: form.elements.description.value,
    sort_order: +form.elements.sort_order.value,
    visible: form.elements.visible.checked,
  };

  if (id) {
    await api('PUT', `/api/admin/categories/${id}`, body);
    toast('Categorie opgeslagen');
  } else {
    await api('POST', '/api/admin/categories', body);
    toast('Categorie aangemaakt');
  }

  closeCatModal();
  refreshCategories();
  loadDashboard();
}

// ── Settings page ─────────────────────────────────────────────────────────────
async function initSettingsPage() {
  const settings = await api('GET', '/api/settings');
  if (!settings) return;

  const form = document.getElementById('settings-form');
  Object.entries(settings).forEach(([key, val]) => {
    const el = form.elements[key];
    if (el) el.value = val;
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const data = {};
    new FormData(form).forEach((v, k) => data[k] = v);
    await api('PUT', '/api/admin/settings', data);
    toast('Instellingen opgeslagen');
  });

  // Profile photo upload
  const profileZone = document.getElementById('profile-upload-zone');
  const profileInput = document.getElementById('profile-input');
  profileZone.addEventListener('click', () => profileInput.click());
  profileInput.addEventListener('change', async () => {
    const file = profileInput.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('photos', file);
    fd.append('category_id', '');
    const result = await apiUpload('/api/admin/photos', fd);
    if (result?.[0]) {
      // Rename via a trick: we just note the filename. The about.html looks for /uploads/profile.jpg
      // For simplicity, show the URL
      toast(`Foto geüpload: ${result[0].filename}. Sla deze naam op.`);
    }
    profileInput.value = '';
  });
}

// ── Messages ──────────────────────────────────────────────────────────────────
async function loadMessages() {
  const msgs = await api('GET', '/api/admin/contacts');
  const list = document.getElementById('message-list');

  if (!msgs?.length) {
    list.innerHTML = '<p style="color:var(--gray);padding:2rem;text-align:center">Nog geen berichten ontvangen.</p>';
    return;
  }

  const unread = msgs.filter(m => !m.read).length;
  const badge = document.getElementById('msg-badge');
  if (unread > 0) {
    badge.textContent = unread;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }

  list.innerHTML = msgs.map(m => `
    <div class="message-card ${!m.read ? 'unread' : ''}" data-id="${m.id}">
      <div class="message-meta">
        <span class="message-name">${escHtml(m.name)}</span>
        <a class="message-email" href="mailto:${escHtml(m.email)}">${escHtml(m.email)}</a>
        ${m.phone ? `<span style="color:var(--gray);font-size:.82rem">${escHtml(m.phone)}</span>` : ''}
        <span class="message-date">${formatDate(m.created_at)}</span>
      </div>
      <p class="message-body">${escHtml(m.message)}</p>
      <div class="message-actions">
        <a href="mailto:${escHtml(m.email)}" class="btn btn-primary btn-sm">Beantwoorden</a>
        ${!m.read ? `<button class="btn btn-outline btn-sm btn-read" data-id="${m.id}">Gelezen</button>` : ''}
        <button class="btn btn-danger btn-sm btn-del-msg" data-id="${m.id}">Verwijderen</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.btn-read').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api('PUT', `/api/admin/contacts/${btn.dataset.id}/read`);
      loadMessages();
    });
  });

  list.querySelectorAll('.btn-del-msg').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Bericht verwijderen?')) return;
      await api('DELETE', `/api/admin/contacts/${btn.dataset.id}`);
      toast('Bericht verwijderd');
      loadMessages();
    });
  });
}

// ── Evenementen ───────────────────────────────────────────────────────────────
let evenementenCatId = null;

function initEventsPage() {
  document.getElementById('new-event-btn').addEventListener('click', () => openEventModal());
  document.getElementById('event-modal-cancel').addEventListener('click', closeEventModal);
  document.getElementById('event-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('event-modal')) closeEventModal();
  });
  document.getElementById('event-form').addEventListener('submit', saveEvent);
}

async function loadEvents() {
  const list = document.getElementById('events-list');
  list.innerHTML = '<p style="color:var(--gray);padding:1rem">Laden...</p>';

  const allCats = await api('GET', '/api/admin/categories');
  const parent = allCats?.find(c => c.slug === 'evenementen' && !c.parent_id);

  if (!parent) {
    list.innerHTML = '<p style="color:var(--gray);padding:1rem">Categorie "Evenementen" niet gevonden. Maak ze eerst aan via Categorieën.</p>';
    return;
  }

  evenementenCatId = parent.id;
  const events = await api('GET', `/api/admin/categories?parent_id=${parent.id}`);

  if (!events?.length) {
    list.innerHTML = `
      <div style="text-align:center;padding:4rem 2rem;color:var(--gray)">
        <svg viewBox="0 0 24 24" style="width:48px;height:48px;fill:#d4d4d8;margin:0 auto 1rem"><path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/></svg>
        <p>Nog geen evenementen.<br>Maak er een aan via de knop hierboven.</p>
      </div>`;
    return;
  }

  list.innerHTML = events.map(ev => `
    <div class="private-gallery-card" id="ev-card-${ev.id}">
      <div class="private-gallery-header" data-id="${ev.id}">
        <div class="private-gallery-icon" style="background:var(--light)">
          ${ev.cover_url
            ? `<img src="${ev.cover_url}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit" alt="">`
            : `<svg viewBox="0 0 24 24" style="fill:var(--gray)"><path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/></svg>`}
        </div>
        <div class="private-gallery-info">
          <div class="private-gallery-name">${escHtml(ev.name)}</div>
          <div class="private-gallery-meta">
            ${ev.event_date ? formatDateShort(ev.event_date) + ' · ' : ''}${ev.photo_count} foto${ev.photo_count !== 1 ? "'s" : ''}${ev.description ? ' · ' + escHtml(ev.description) : ''}
          </div>
        </div>
        <div class="private-gallery-expand">
          <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
        </div>
      </div>
      <div class="private-gallery-body">
        <div class="private-gallery-actions">
          <label class="btn btn-primary btn-sm" style="cursor:pointer">
            <svg viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>
            Foto's uploaden
            <input type="file" multiple accept="image/*" class="ev-upload-input" data-event="${ev.id}" style="display:none">
          </label>
          <button class="btn btn-outline btn-sm btn-edit-ev" data-id="${ev.id}">Bewerken</button>
          <button class="btn btn-danger btn-sm btn-del-ev" data-id="${ev.id}">Verwijderen</button>
        </div>
        <div class="photo-grid pg-photo-grid" id="ev-grid-${ev.id}">
          <p style="color:var(--gray);grid-column:1/-1;font-size:.85rem">Klik op de header om foto's te zien.</p>
        </div>
        <div class="upload-progress" id="ev-progress-${ev.id}"></div>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.private-gallery-header').forEach(header => {
    header.addEventListener('click', e => {
      if (e.target.closest('button, label')) return;
      const card = header.closest('.private-gallery-card');
      const wasOpen = card.classList.contains('open');
      card.classList.toggle('open');
      if (!wasOpen) loadEventPhotos(header.dataset.id);
    });
  });

  list.querySelectorAll('.btn-edit-ev').forEach(btn => {
    btn.addEventListener('click', () => {
      const ev = events.find(e => e.id === +btn.dataset.id);
      openEventModal(ev);
    });
  });

  list.querySelectorAll('.btn-del-ev').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ev = events.find(e => e.id === +btn.dataset.id);
      if (!confirm(`Evenement "${ev.name}" en alle bijbehorende foto's verwijderen?`)) return;
      await api('DELETE', `/api/admin/categories/${btn.dataset.id}`);
      toast('Evenement verwijderd');
      loadEvents();
    });
  });

  list.querySelectorAll('.ev-upload-input').forEach(input => {
    input.addEventListener('change', async () => {
      const eventId = input.dataset.event;
      const files = [...input.files];
      input.value = '';
      if (!files.length) return;

      const card = document.getElementById(`ev-card-${eventId}`);
      if (!card.classList.contains('open')) card.classList.add('open');

      const progressEl = document.getElementById(`ev-progress-${eventId}`);
      progressEl.innerHTML = `<div class="progress-item"><span>${files.length} foto${files.length > 1 ? "'s" : ''} uploaden...</span><div class="progress-bar-wrap"><div class="progress-bar" id="ev-bar-${eventId}" style="width:0%"></div></div></div>`;

      const fd = new FormData();
      fd.append('category_id', eventId);
      files.forEach(f => fd.append('photos', f));

      let prog = 0;
      const iv = setInterval(() => {
        prog = Math.min(prog + 15, 85);
        const bar = document.getElementById(`ev-bar-${eventId}`);
        if (bar) bar.style.width = prog + '%';
      }, 200);

      const result = await apiUpload('/api/admin/photos', fd);
      clearInterval(iv);

      if (result?.length) {
        toast(`${result.length} foto${result.length > 1 ? "'s" : ''} toegevoegd`);
        setTimeout(() => progressEl.innerHTML = '', 2000);
        loadEventPhotos(eventId);
        loadEvents();
      } else {
        toast('Upload mislukt', true);
        progressEl.innerHTML = '';
      }
    });
  });
}

async function loadEventPhotos(eventId) {
  const grid = document.getElementById(`ev-grid-${eventId}`);
  if (!grid) return;
  grid.innerHTML = '<p style="color:var(--gray);grid-column:1/-1;font-size:.85rem">Laden...</p>';

  const [photos, allCats] = await Promise.all([
    api('GET', `/api/admin/photos?category_id=${eventId}`),
    api('GET', '/api/admin/categories'),
  ]);
  const ev = allCats?.find(c => c.id === +eventId);

  if (!photos?.length) {
    grid.innerHTML = '<p style="color:var(--gray);grid-column:1/-1;font-size:.85rem">Nog geen foto\'s. Upload er hierboven.</p>';
    return;
  }

  grid.innerHTML = photos.map(p => `
    <div class="photo-thumb" data-id="${p.id}">
      <img src="${p.url || '/uploads/' + p.filename}" alt="${p.title || ''}" loading="lazy">
      ${ev?.cover_photo_id === p.id ? '<span class="photo-cover-badge">Cover</span>' : ''}
      <div class="photo-thumb-actions">
        <button class="btn-cover-ev" data-id="${p.id}" data-event="${eventId}">Als cover</button>
        <button class="btn-del-ev-photo" data-id="${p.id}" data-event="${eventId}">Verwijderen</button>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.btn-cover-ev').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api('PUT', `/api/admin/categories/${btn.dataset.event}/cover`, { photo_id: +btn.dataset.id });
      toast('Coverfoto ingesteld');
      loadEventPhotos(eventId);
      loadEvents();
    });
  });

  grid.querySelectorAll('.btn-del-ev-photo').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Foto verwijderen?')) return;
      await api('DELETE', `/api/admin/photos/${btn.dataset.id}`);
      toast('Foto verwijderd');
      loadEventPhotos(eventId);
      loadEvents();
    });
  });
}

function openEventModal(event = null) {
  const form = document.getElementById('event-form');
  form.reset();
  document.getElementById('event-modal-title').textContent = event ? 'Evenement bewerken' : 'Evenement toevoegen';
  if (event) {
    form.elements.id.value = event.id;
    form.elements.name.value = event.name;
    form.elements.event_date.value = event.event_date || '';
    form.elements.description.value = event.description || '';
    form.elements.sort_order.value = event.sort_order;
  }
  document.getElementById('event-modal').classList.add('open');
  form.elements.name.focus();
}

function closeEventModal() {
  document.getElementById('event-modal').classList.remove('open');
}

async function saveEvent(e) {
  e.preventDefault();
  const form = e.target;
  const id = form.elements.id.value;
  const body = {
    name: form.elements.name.value,
    event_date: form.elements.event_date.value,
    description: form.elements.description.value,
    sort_order: +form.elements.sort_order.value,
    visible: true,
    parent_id: evenementenCatId,
  };

  if (id) {
    await api('PUT', `/api/admin/categories/${id}`, body);
    toast('Evenement opgeslagen');
  } else {
    const result = await api('POST', '/api/admin/categories', body);
    if (result?.error) { toast(result.error, true); return; }
    toast('Evenement aangemaakt');
  }

  closeEventModal();
  loadEvents();
}

// ── Private galleries ─────────────────────────────────────────────────────────
function initPrivatePage() {
  document.getElementById('new-private-btn').addEventListener('click', () => openPrivateModal());
  document.getElementById('private-modal-cancel').addEventListener('click', closePrivateModal);
  document.getElementById('private-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('private-modal')) closePrivateModal();
  });
  document.getElementById('private-form').addEventListener('submit', savePrivateGallery);

  document.getElementById('generate-password').addEventListener('click', () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const pw = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    document.getElementById('private-password').value = pw;
  });
}

async function loadPrivateGalleries() {
  const list = document.getElementById('private-list');
  list.innerHTML = '<p style="color:var(--gray);padding:1rem">Laden...</p>';

  const galleries = await api('GET', '/api/admin/private-galleries');

  if (!galleries?.length) {
    list.innerHTML = `
      <div style="text-align:center;padding:4rem 2rem;color:var(--gray)">
        <svg viewBox="0 0 24 24" style="width:48px;height:48px;fill:#d4d4d8;margin:0 auto 1rem"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
        <p>Nog geen privé galerijen.<br>Maak er een aan voor je eerste klant.</p>
      </div>`;
    return;
  }

  list.innerHTML = galleries.map(g => `
    <div class="private-gallery-card" id="pg-${g.id}">
      <div class="private-gallery-header" data-id="${g.id}">
        <div class="private-gallery-icon">
          <svg viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
        </div>
        <div class="private-gallery-info">
          <div class="private-gallery-name">${escHtml(g.name)}</div>
          <div class="private-gallery-meta">
            ${g.event_date ? formatDateShort(g.event_date) + ' · ' : ''}${g.photo_count} foto${g.photo_count !== 1 ? "'s" : ''}
            ${g.description ? ' · ' + escHtml(g.description) : ''}
          </div>
        </div>
        <div class="private-gallery-password" title="Toegangscode klant">
          <svg viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
          <span>${escHtml(g.password)}</span>
          <button class="copy-pw-btn" data-pw="${escHtml(g.password)}" title="Kopieer wachtwoord">
            <svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
          </button>
        </div>
        <div class="private-gallery-expand">
          <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>
        </div>
      </div>
      <div class="private-gallery-body">
        <div class="private-gallery-actions">
          <label class="btn btn-primary btn-sm" style="cursor:pointer">
            <svg viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>
            Foto's uploaden
            <input type="file" multiple accept="image/*" class="pg-upload-input" data-gallery="${g.id}" style="display:none">
          </label>
          <button class="btn btn-outline btn-sm btn-edit-pg" data-id="${g.id}">Bewerken</button>
          <button class="btn btn-danger btn-sm btn-del-pg" data-id="${g.id}">Verwijderen</button>
          <button class="btn btn-outline btn-sm copy-instructions-btn" data-name="${escHtml(g.name)}" data-pw="${escHtml(g.password)}">
            <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>
            Kopieer instructies
          </button>
        </div>
        <div class="photo-grid pg-photo-grid" id="pg-grid-${g.id}">
          <p style="color:var(--gray);grid-column:1/-1;font-size:.85rem">Klik op de header om foto's te zien.</p>
        </div>
        <div class="upload-progress" id="pg-progress-${g.id}"></div>
      </div>
    </div>
  `).join('');

  // Expand/collapse
  list.querySelectorAll('.private-gallery-header').forEach(header => {
    header.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      const card = header.closest('.private-gallery-card');
      const wasOpen = card.classList.contains('open');
      card.classList.toggle('open');
      if (!wasOpen) loadPrivatePhotos(header.dataset.id);
    });
  });

  // Copy password
  list.querySelectorAll('.copy-pw-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      navigator.clipboard.writeText(btn.dataset.pw);
      toast('Wachtwoord gekopieerd');
    });
  });

  // Copy instructions
  list.querySelectorAll('.copy-instructions-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const baseUrl = window.location.origin;
      const text = `Beste ${btn.dataset.name},\n\nJe foto's zijn klaar! Bekijk ze via:\n🔗 ${baseUrl}/prive\n🔑 Toegangscode: ${btn.dataset.pw}\n\nDruk in de galerij op een foto om hem te vergroten en te downloaden.`;
      navigator.clipboard.writeText(text);
      toast('Instructies gekopieerd naar klembord!');
    });
  });

  // Edit
  list.querySelectorAll('.btn-edit-pg').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = galleries.find(g => g.id === +btn.dataset.id);
      openPrivateModal(g);
    });
  });

  // Delete
  list.querySelectorAll('.btn-del-pg').forEach(btn => {
    btn.addEventListener('click', async () => {
      const g = galleries.find(g => g.id === +btn.dataset.id);
      if (!confirm(`Galerij "${g.name}" en alle foto's verwijderen?`)) return;
      await api('DELETE', `/api/admin/private-galleries/${btn.dataset.id}`);
      toast('Galerij verwijderd');
      loadPrivateGalleries();
    });
  });

  // Photo upload
  list.querySelectorAll('.pg-upload-input').forEach(input => {
    input.addEventListener('change', async () => {
      const galleryId = input.dataset.gallery;
      const files = [...input.files];
      input.value = '';
      if (!files.length) return;

      const progressEl = document.getElementById(`pg-progress-${galleryId}`);
      progressEl.innerHTML = `<div class="progress-item"><span>${files.length} foto${files.length > 1 ? "'s" : ''} uploaden...</span><div class="progress-bar-wrap"><div class="progress-bar" id="pg-bar-${galleryId}" style="width:0%"></div></div></div>`;

      const fd = new FormData();
      fd.append('gallery_id', galleryId);
      files.forEach(f => fd.append('photos', f));

      let prog = 0;
      const iv = setInterval(() => {
        prog = Math.min(prog + 15, 85);
        const bar = document.getElementById(`pg-bar-${galleryId}`);
        if (bar) bar.style.width = prog + '%';
      }, 200);

      const result = await apiUpload('/api/admin/private-photos', fd);
      clearInterval(iv);

      if (result?.length) {
        toast(`${result.length} foto${result.length > 1 ? "'s" : ''} toegevoegd`);
        setTimeout(() => progressEl.innerHTML = '', 2000);
        loadPrivatePhotos(galleryId);
      } else {
        toast('Upload mislukt', true);
        progressEl.innerHTML = '';
      }
    });
  });
}

async function loadPrivatePhotos(galleryId) {
  const grid = document.getElementById(`pg-grid-${galleryId}`);
  if (!grid) return;
  grid.innerHTML = '<p style="color:var(--gray);grid-column:1/-1;font-size:.85rem">Laden...</p>';

  const photos = await api('GET', `/api/admin/private-photos?gallery_id=${galleryId}`);

  if (!photos?.length) {
    grid.innerHTML = '<p style="color:var(--gray);grid-column:1/-1;font-size:.85rem">Nog geen foto\'s. Upload er hierboven.</p>';
    return;
  }

  grid.innerHTML = photos.map(p => `
    <div class="photo-thumb" data-id="${p.id}">
      <img src="/uploads/${p.filename}" alt="" loading="lazy">
      <div class="photo-thumb-actions">
        <button class="btn-del-pp" data-id="${p.id}">Verwijderen</button>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.btn-del-pp').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Foto verwijderen?')) return;
      await api('DELETE', `/api/admin/private-photos/${btn.dataset.id}`);
      toast('Foto verwijderd');
      loadPrivatePhotos(galleryId);
    });
  });
}

function openPrivateModal(gallery = null) {
  const form = document.getElementById('private-form');
  form.reset();
  const isEdit = !!gallery;
  document.getElementById('private-modal-title').textContent = isEdit ? 'Galerij bewerken' : 'Privé galerij aanmaken';

  const pwInput = document.getElementById('private-password');
  const pwLabel = document.getElementById('password-label');
  const pwHint = document.getElementById('password-hint');

  if (isEdit) {
    form.elements.id.value = gallery.id;
    form.elements.name.value = gallery.name;
    form.elements.description.value = gallery.description || '';
    form.elements.event_date.value = gallery.event_date || '';
    form.elements.password.value = gallery.password;
    pwLabel.textContent = 'Toegangscode';
    pwInput.required = false;
    pwHint.textContent = 'Huidige code staat ingevuld. Wijzig indien gewenst.';
  } else {
    // Auto-generate a password
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    pwInput.value = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    pwLabel.textContent = 'Toegangscode *';
    pwInput.required = true;
    pwHint.textContent = 'Automatisch gegenereerd. Je kan het aanpassen. Deel dit met de klant.';
  }

  document.getElementById('private-modal').classList.add('open');
  form.elements.name.focus();
}

function closePrivateModal() {
  document.getElementById('private-modal').classList.remove('open');
}

async function savePrivateGallery(e) {
  e.preventDefault();
  const form = e.target;
  const id = form.elements.id.value;
  const body = {
    name: form.elements.name.value,
    description: form.elements.description.value,
    event_date: form.elements.event_date.value,
    password: form.elements.password.value,
  };

  let result;
  if (id) {
    result = await api('PUT', `/api/admin/private-galleries/${id}`, body);
  } else {
    result = await api('POST', '/api/admin/private-galleries', body);
  }

  if (result?.error) {
    toast(result.error, true);
    return;
  }

  toast(id ? 'Galerij bijgewerkt' : 'Galerij aangemaakt!');
  closePrivateModal();
  loadPrivateGalleries();
}

function formatDateShort(str) {
  if (!str) return '';
  return new Date(str + 'T00:00:00').toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(str) {
  if (!str) return '';
  return new Date(str).toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
