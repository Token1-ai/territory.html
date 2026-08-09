// Gate Territory — отправка уведомления хозяину осаждённой точки.
// Живёт на Vercel. Телефон нападающего зовёт этот адрес сразу после
// начала осады, но на слово ему никто не верит: функция сама idёт в
// базу служебным ключом и проверяет, что осада правда живая.
//
// Настройки берутся из переменных окружения Vercel:
//   VAPID_PUBLIC, VAPID_PRIVATE, SUPABASE_KEY

const webpush = require('web-push');

const SB_URL = 'https://hgzthbidfdqomuotdocb.supabase.co';

const TEXT = {
  en: { t: 'Your point is under attack',  b: 'Come back and defend it — repairs slow the attacker down.' },
  ru: { t: 'На твою точку напали',        b: 'Возвращайся и защищай — починка тормозит нападающего.' },
  uk: { t: 'На твою точку напали',        b: 'Повертайся й борони — лагодження гальмує нападника.' },
  pl: { t: 'Twój punkt jest atakowany',   b: 'Wracaj i broń — naprawa spowalnia napastnika.' },
  de: { t: 'Dein Punkt wird angegriffen', b: 'Komm zurück und verteidige — Reparatur bremst den Angreifer.' },
  es: { t: 'Atacan tu punto',             b: 'Vuelve y defiéndelo: reparar frena al atacante.' },
  tr: { t: 'Noktana saldırıyorlar',       b: 'Dön ve savun — onarım saldırganı yavaşlatır.' },
  zh: { t: '你的据点遭到进攻',              b: '快回去防守——修复会拖慢进攻方。' },
};

async function sb(path, opts = {}) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: process.env.SUPABASE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error('supabase ' + r.status);
  return r.json();
}

// Тихие часы: будить человека в четыре утра из-за чужого бункера незачем
function quiet(sub) {
  if (sub.quiet_from == null || sub.quiet_to == null) return false;
  const h = new Date().getUTCHours();
  return sub.quiet_from < sub.quiet_to
    ? h >= sub.quiet_from && h < sub.quiet_to
    : h >= sub.quiet_from || h < sub.quiet_to;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'post only' });
  if (!process.env.VAPID_PRIVATE || !process.env.SUPABASE_KEY) {
    return res.status(500).json({ error: 'not configured' });
  }

  const siegeId = Number((req.body && req.body.siege_id) || 0);
  if (!siegeId) return res.status(400).json({ error: 'no siege_id' });

  try {
    // 1. Осада правда идёт? Верим базе, а не звонящему.
    const sg = await sb(`territory_sieges?id=eq.${siegeId}&state=eq.live&select=id,bunker_id,attacker`);
    if (!sg.length) return res.status(200).json({ ok: true, sent: 0, why: 'no live siege' });

    // 2. Кто хозяин точки
    const bk = await sb(`territory_bunkers?id=eq.${sg[0].bunker_id}&select=owner`);
    if (!bk.length) return res.status(200).json({ ok: true, sent: 0 });
    const owner = bk[0].owner;
    if (owner === sg[0].attacker) return res.status(200).json({ ok: true, sent: 0 });

    // 3. Его телефоны
    const subs = await sb(
      `territory_push?wallet=eq.${owner}&select=id,endpoint,p256dh,auth,lang,quiet_from,quiet_to`
    );
    if (!subs.length) return res.status(200).json({ ok: true, sent: 0, why: 'not subscribed' });

    webpush.setVapidDetails(
      'mailto:hello@opengate.bond',
      process.env.VAPID_PUBLIC,
      process.env.VAPID_PRIVATE
    );

    let sent = 0, dead = [];
    await Promise.all(
      subs.map(async (s) => {
        if (quiet(s)) return;
        const t = TEXT[s.lang] || TEXT.en;
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify({ title: t.t, body: t.b, tag: 'siege-' + siegeId, url: '/' })
          );
          sent++;
        } catch (e) {
          // 404 и 410 значат, что телефон отписался навсегда
          if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.id);
        }
      })
    );

    if (dead.length) {
      await sb(`territory_push?id=in.(${dead.join(',')})`, { method: 'DELETE' }).catch(() => {});
    }
    return res.status(200).json({ ok: true, sent });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
};
