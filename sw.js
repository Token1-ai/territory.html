// Gate Territory — работа без сети.
// Держим в телефоне оболочку приложения и плитки карты тех мест, где
// человек уже был. Ходил по району — район открывается без интернета.
// ── ПРО ОБНОВЛЕНИЯ ────────────────────────────────────────────────
// Раньше новый работник вступал в силу сразу, а страница у человека
// оставалась старой. Получалась смесь: часть кода новая, часть старая,
// и на разных телефонах игра вела себя по-разному.
//
// Теперь новый работник ЖДЁТ. Игра замечает его и показывает полосу
// «есть обновление». Нажал — работник получает команду вступить в
// силу, страница перезагружается разом, смеси не остаётся.
//
// ВАЖНО: этот номер надо поднимать при каждой выкладке. По нему
// браузер и понимает, что появилось новое.
const SHELL = 'ogt-shell-v19';
const TILES = 'ogt-tiles-v1';
const TILE_CAP = 900;                 // примерно 25-40 МБ, дальше чистим старое

const SHELL_FILES = [
  './', './index.html', './manifest.json', './splash-1080.webp', './lang.json', './pay.html',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// Кладём по одному файлу. addAll бросает всё целиком, если не скачался
// хоть один — тогда кэш остаётся пустым, и приложение падает при втором
// запуске. Проверено: именно так и произошло.
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map(async u => {
      try { const r = await fetch(u, { cache:'reload' }); if(r && r.ok) await c.put(u, r); }
      catch(_) {}
    }));
    // Сами в силу НЕ вступаем: ждём согласия человека. Исключение —
    // самая первая установка, там перехватывать нечего.
    const cs = await self.clients.matchAll();
    if(cs.length === 0) await self.skipWaiting();
  })());
});

// Человек нажал «обновить» — вот теперь вступаем.
self.addEventListener('message', e => {
  if(e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trimTiles(c){
  const keys = await c.keys();
  if(keys.length <= TILE_CAP) return;
  for(let i = 0; i < keys.length - TILE_CAP; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const url = e.request.url;
  if(e.request.method !== 'GET') return;
  if(url.indexOf('supabase.co') !== -1) return;   // база и подписки — только из сети
  if(url.indexOf('version.json') !== -1) return;  // метка версии всегда свежая, мимо кэша

  // Плитки карты: сначала телефон, потом сеть
  if(url.indexOf('tile.openstreetmap.org') !== -1){
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(e.request);
      // Плитка уже есть — отдаём и НИЧЕГО не докачиваем. Карта улиц
      // не меняется неделями, а фоновая перекачка жгла и трафик, и
      // батарею на каждом просмотре одного и того же двора.
      if(hit) return hit;
      try{
        const r = await fetch(e.request);
        if(r && r.ok){ c.put(e.request, r.clone()); trimTiles(c); }
        return r;
      }catch(_){
        // Нет ни сети, ни плитки — пустой квадрат вместо разорванной карты
        return new Response('', { status:200, headers:{'Content-Type':'image/png'} });
      }
    })());
    return;
  }

  // Оболочка: сначала сеть, при неудаче — телефон. Так человек всегда
  // получает свежую версию, а без интернета игра всё равно открывается.
  e.respondWith((async () => {
    try{
      const r = await fetch(e.request);
      if(r && r.ok){
        const cl = r.clone();
        caches.open(SHELL).then(c => c.put(e.request, cl)).catch(()=>{});
      }
      return r;
    }catch(_){
      const hit = await caches.match(e.request);
      if(hit) return hit;
      if(e.request.mode === 'navigate'){
        const shell = await caches.match('./index.html');
        if(shell) return shell;
      }
      return new Response('', { status:504, statusText:'offline' });
    }
  })());
});

// ═══════════ Уведомления ═══════════
// Приходят, даже когда игра закрыта. На Android работает из обычного
// браузера, на iPhone — только если значок вынесен на экран.
self.addEventListener('push', e => {
  let d = {};
  try{ d = e.data ? e.data.json() : {}; }catch(_){ d = {}; }
  e.waitUntil(self.registration.showNotification(
    d.title || 'Gate Territory',
    {
      body: d.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: d.tag || 'ogt',
      renotify: true,
      vibrate: [200, 80, 200],
      data: { url: d.url || './' }
    }
  ));
});

// Нажал на уведомление — открываем уже запущенную игру, а не вторую копию
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for(const c of all){
      if(c.url.indexOf(self.registration.scope) === 0){ await c.focus(); return; }
    }
    await clients.openWindow(url);
  })());
});
