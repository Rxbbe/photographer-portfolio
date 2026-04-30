// ── Shared state ──────────────────────────────────────────────────────────────
let siteSettings = {};
let galleryPhotos = [];
let lightboxIndex = 0;
let touchStartX = 0;

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  siteSettings = await fetch('/api/settings').then(r => r.json()).catch(() => ({}));
  applyGlobalSettings();
  buildNav();

  const page = document.body.dataset.page;
  if (page === 'home') initHome();
  else if (page === 'gallery') initGallery();
  else if (page === 'about') initAbout();
  else if (page === 'contact') initContact();
}

// ── Global settings ───────────────────────────────────────────────────────────
function applyGlobalSettings() {
  const logo = document.getElementById('site-logo');
  if (logo) logo.textContent = siteSettings.site_name || 'Fotograaf';

  document.title = siteSettings.site_name || 'Fotograaf';

  // Social links
  const socials = document.querySelectorAll('.footer-social, .social-links');
  socials.forEach(el => {
    el.innerHTML = '';
    if (siteSettings.instagram_url) {
      el.innerHTML += `<a href="${siteSettings.instagram_url}" target="_blank" rel="noopener" aria-label="Instagram">
        <svg viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
      </a>`;
    }
    if (siteSettings.facebook_url) {
      el.innerHTML += `<a href="${siteSettings.facebook_url}" target="_blank" rel="noopener" aria-label="Facebook">
        <svg viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
      </a>`;
    }
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function buildNav() {
  const nav = document.getElementById('site-nav');
  if (!nav) return;

  const cats = await fetch('/api/categories').then(r => r.json()).catch(() => []);
  const currentPage = document.body.dataset.page;
  const currentSlug = new URLSearchParams(window.location.search).get('slug');

  let links = `
    <a href="/" class="${currentPage === 'home' ? 'active' : ''}">Home</a>
    <a href="/about.html" class="${currentPage === 'about' ? 'active' : ''}">Over mij</a>
  `;
  cats.forEach(c => {
    const isActive = currentPage === 'gallery' && currentSlug === c.slug;
    links += `<a href="/gallery.html?slug=${c.slug}" class="${isActive ? 'active' : ''}">${c.name}</a>`;
  });
  links += `<a href="/contact.html" class="${currentPage === 'contact' ? 'active' : ''}">Contact</a>`;
  links += `<a href="/prive">Privé galerij</a>`;

  nav.innerHTML = links;

  // Hamburger
  const hamburger = document.getElementById('hamburger');
  if (hamburger) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('open');
      nav.classList.toggle('open');
    });
  }

  // Scroll shadow
  window.addEventListener('scroll', () => {
    document.querySelector('.site-header')?.classList.toggle('scrolled', window.scrollY > 20);
  });
}

// ── Homepage ──────────────────────────────────────────────────────────────────
async function initHome() {
  // Apply hero settings
  const heroTitle = document.getElementById('hero-title');
  const heroSub = document.getElementById('hero-subtitle');
  if (heroTitle) heroTitle.innerHTML = siteSettings.hero_title?.replace(/\n/g, '<br>') || 'Fotograaf';
  if (heroSub) heroSub.textContent = siteSettings.hero_subtitle || '';

  const grid = document.getElementById('categories-grid');
  if (!grid) return;

  grid.innerHTML = '<div class="skeleton" style="grid-column:1/3;aspect-ratio:4/3"></div><div class="skeleton" style="aspect-ratio:4/5"></div>';

  const cats = await fetch('/api/categories').then(r => r.json()).catch(() => []);
  if (!cats.length) {
    grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:#888;padding:3rem">Nog geen categorieën aangemaakt.</p>';
    return;
  }

  grid.innerHTML = cats.map((c, i) => `
    <a href="/gallery.html?slug=${c.slug}" class="cat-card" style="${i === 0 ? 'grid-column:1/3' : ''}">
      ${c.cover_url
        ? `<img src="${c.cover_url}" alt="${c.name}" loading="lazy">`
        : `<div class="cat-placeholder">Geen foto's</div>`}
      <div class="cat-card-overlay">
        <div class="cat-card-name">${c.name}</div>
        ${c.description ? `<div class="cat-card-desc">${c.description}</div>` : ''}
        <div class="cat-card-count">${c.photo_count} foto${c.photo_count !== 1 ? "'s" : ''}</div>
      </div>
    </a>
  `).join('');

  if (cats.length > 3) grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
}

// ── Gallery page ──────────────────────────────────────────────────────────────
async function initGallery() {
  const slug = new URLSearchParams(window.location.search).get('slug');
  if (!slug) { window.location.href = '/'; return; }

  const [cat, photos] = await Promise.all([
    fetch(`/api/categories/${slug}`).then(r => r.ok ? r.json() : null),
    fetch(`/api/categories/${slug}/photos`).then(r => r.json()).catch(() => []),
  ]);

  if (!cat) { window.location.href = '/'; return; }

  document.title = `${cat.name} — ${siteSettings.site_name || 'Fotograaf'}`;
  const h1 = document.getElementById('gallery-title');
  const desc = document.getElementById('gallery-desc');
  if (h1) h1.textContent = cat.name;
  if (desc) desc.textContent = cat.description || '';

  galleryPhotos = photos;
  const grid = document.getElementById('gallery-grid');
  if (!grid) return;

  if (!photos.length) {
    grid.innerHTML = '<div class="gallery-empty">Nog geen foto\'s in deze categorie.</div>';
    return;
  }

  grid.innerHTML = photos.map((p, i) => `
    <div class="gallery-item" data-index="${i}">
      <img src="${p.url}" alt="${p.title || ''}" loading="lazy">
      <div class="gallery-item-overlay">
        <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.gallery-item').forEach(item => {
    item.addEventListener('click', () => openLightbox(+item.dataset.index));
  });

  initLightbox();
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function initLightbox() {
  const lb = document.getElementById('lightbox');
  if (!lb) return;

  document.getElementById('lb-close').addEventListener('click', closeLightbox);
  document.getElementById('lb-prev').addEventListener('click', () => moveLightbox(-1));
  document.getElementById('lb-next').addEventListener('click', () => moveLightbox(1));

  lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });

  document.addEventListener('keydown', e => {
    if (!lb.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') moveLightbox(-1);
    if (e.key === 'ArrowRight') moveLightbox(1);
  });

  // Touch swipe
  lb.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) moveLightbox(dx < 0 ? 1 : -1);
  });
}

function openLightbox(index) {
  lightboxIndex = index;
  renderLightbox();
  document.getElementById('lightbox').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.body.style.overflow = '';
}

function moveLightbox(dir) {
  lightboxIndex = (lightboxIndex + dir + galleryPhotos.length) % galleryPhotos.length;
  renderLightbox();
}

function renderLightbox() {
  const photo = galleryPhotos[lightboxIndex];
  const img = document.getElementById('lb-img');
  const caption = document.getElementById('lb-caption');
  const counter = document.getElementById('lb-counter');

  img.src = photo.url;
  img.alt = photo.title || '';
  if (caption) caption.textContent = photo.title || '';
  if (counter) counter.textContent = `${lightboxIndex + 1} / ${galleryPhotos.length}`;

  // Animate
  img.style.animation = 'none';
  img.offsetHeight;
  img.style.animation = '';
}

// ── About page ────────────────────────────────────────────────────────────────
function initAbout() {
  const title = document.getElementById('about-title');
  const text = document.getElementById('about-text');
  const quote = document.getElementById('about-quote');

  if (title) title.textContent = siteSettings.about_title || 'Over Mij';
  if (text) text.textContent = siteSettings.about_text || '';
  if (quote) {
    if (siteSettings.about_quote) {
      quote.textContent = `"${siteSettings.about_quote}"`;
      quote.style.display = '';
    } else {
      quote.style.display = 'none';
    }
  }

  document.title = `Over mij — ${siteSettings.site_name || 'Fotograaf'}`;
}

// ── Contact page ──────────────────────────────────────────────────────────────
function initContact() {
  document.title = `Contact — ${siteSettings.site_name || 'Fotograaf'}`;

  const emailEl = document.getElementById('contact-email');
  const phoneEl = document.getElementById('contact-phone');
  const locationEl = document.getElementById('contact-location');

  if (emailEl && siteSettings.contact_email) {
    emailEl.href = `mailto:${siteSettings.contact_email}`;
    emailEl.querySelector('span').textContent = siteSettings.contact_email;
    emailEl.parentElement.style.display = '';
  }
  if (phoneEl && siteSettings.contact_phone) {
    phoneEl.href = `tel:${siteSettings.contact_phone}`;
    phoneEl.querySelector('span').textContent = siteSettings.contact_phone;
    phoneEl.parentElement.style.display = '';
  }
  if (locationEl && siteSettings.contact_location) {
    locationEl.textContent = siteSettings.contact_location;
  }

  const form = document.getElementById('contact-form');
  const msg = document.getElementById('form-message');

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Versturen...';

    const data = {
      name: form.name.value,
      email: form.email.value,
      phone: form.phone.value,
      message: form.message.value,
    };

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        msg.className = 'form-message success';
        msg.textContent = 'Bedankt! Ik neem zo snel mogelijk contact met je op.';
        form.reset();
      } else {
        const err = await res.json();
        msg.className = 'form-message error';
        msg.textContent = err.error || 'Er ging iets mis. Probeer opnieuw.';
      }
    } catch {
      msg.className = 'form-message error';
      msg.textContent = 'Er ging iets mis. Controleer je verbinding.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Versturen';
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
