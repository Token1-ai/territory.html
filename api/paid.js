// Gate Territory — приём денег с карты.
//
// ПОЧЕМУ ФАЙЛ ОДИН, А КОНТОР МОЖЕТ БЫТЬ МНОГО.
// Здесь только развилка и общая часть. У каждой конторы свой маленький
// переходник в ADAPTERS: он берёт письмо в её формате и приводит к
// общему виду — «номер платежа, игрок, центы, это возврат или нет».
// Сменить контору = дописать переходник на 20 строк. База, игра и всё
// остальное не трогаются.
//
// АДРЕС. POST /api/paid?p=gumroad&s=СЕКРЕТ
// Секрет лежит в переменной PAY_SECRET и служит первым забором: без
// него письмо даже не читаем.
//
// ПОЧЕМУ ПИСЬМУ НЕЛЬЗЯ ВЕРИТЬ. Кто угодно может постучаться на этот
// адрес и написать «мне заплатили сто долларов». Поэтому сумму и факт
// оплаты берём НЕ из письма, а спрашиваем у самой конторы по номеру
// платежа. Письмо — только повод сходить и проверить.
//
// Переменные окружения в Vercel:
//   SUPABASE_KEY   — служебный ключ базы (уже есть, тот же что у topup)
//   PAY_SECRET     — придуманная строка, она же в адресе вебхука
//   GUMROAD_TOKEN  — ключ доступа Gumroad, для проверки платежа

const SB_URL = 'https://hgzthbidfdqomuotdocb.supabase.co';

async function sbRpc(fn, body) {
  const r = await fetch(SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('supabase ' + r.status);
  return r.json();
}

// Номер игрока может приехать под разными именами — в зависимости от
// того, как контора называет «данные, которые мы передали с покупкой».
// Ищем во всех местах сразу, а не гадаем.
function findPlayer(obj) {
  const want = /^0x[0-9a-fA-F]{40}$/;
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || depth > 4 || typeof o !== 'object') return null;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') {
        const s = v.trim();
        if (want.test(s)) return s.toLowerCase();
        // иногда приезжает как "player=0x…" одной строкой
        const m = s.match(/0x[0-9a-fA-F]{40}/);
        if (m && /player|wallet|игрок/i.test(k)) return m[0].toLowerCase();
      } else if (v && typeof v === 'object' && !seen.has(v)) {
        seen.add(v);
        const got = walk(v, depth + 1);
        if (got) return got;
      }
    }
    return null;
  };
  return walk(obj, 0);
}

function truthy(v) {
  return v === true || v === 'true' || v === '1' || v === 1;
}

// ══════════════ Переходники ══════════════

const ADAPTERS = {
  // ── Gumroad ───────────────────────────────────────────────────
  // Ping приходит обычной формой. Ему НЕ верим: берём из него только
  // номер продажи, а сумму и «правда ли оплачено» спрашиваем у
  // Gumroad по их же ключу.
  async gumroad(body) {
    const saleId = String(
      body.sale_id || body.saleId || body.id || ''
    ).trim();
    if (!saleId) return { error: 'no_sale_id' };

    const token = process.env.GUMROAD_TOKEN;
    if (!token) return { error: 'no_gumroad_token' };

    let sale = null;
    try {
      const r = await fetch(
        'https://api.gumroad.com/v2/sales/' + encodeURIComponent(saleId) +
        '?access_token=' + encodeURIComponent(token),
        { headers: { Accept: 'application/json' } }
      );
      const j = await r.json();
      if (j && j.success && j.sale) sale = j.sale;
    } catch (e) {}

    // Контора не подтвердила — НИЧЕГО не зачисляем. Лучше разобраться
    // руками, чем раздать деньги по чужому письму.
    if (!sale) return { error: 'not_confirmed_by_gumroad', saleId };

    const refunded =
      truthy(sale.refunded) || truthy(sale.disputed) ||
      truthy(sale.chargebacked) || truthy(sale.chargeback);

    // price у Gumroad уже в центах
    const cents = Math.floor(Number(sale.price));
    const player = findPlayer(sale) || findPlayer(body);

    return { ext_id: saleId, cents, player, refunded, raw: sale };
  },

  // ── Место под следующую контору ───────────────────────────────
  // Появится Stripe или другой — переходник пишется здесь, и всё.
  // async stripe(body, req) { … return { ext_id, cents, player, refunded }; },
};

// ══════════════ Общая часть ══════════════

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'post only' });
  if (!process.env.SUPABASE_KEY) return res.status(500).json({ error: 'not configured' });

  // забор первый: секрет в адресе
  const secret = process.env.PAY_SECRET;
  if (!secret || String(req.query.s || '') !== secret) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const prov = String(req.query.p || '').toLowerCase();
  const adapter = ADAPTERS[prov];
  if (!adapter) return res.status(400).json({ error: 'unknown_provider', prov });

  // Vercel сам разбирает и форму, и JSON. На всякий случай терпим оба.
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  try {
    const out = await adapter(body, req);

    // Первое время печатаем письмо целиком: так видно, как контора
    // на самом деле называет поля, и не приходится гадать.
    console.log('[paid] ' + prov + ' ' + JSON.stringify({
      got: { ext_id: out.ext_id, cents: out.cents, player: out.player,
             refunded: out.refunded, error: out.error },
      body: body,
    }).slice(0, 4000));

    if (out.error) return res.status(200).json({ ok: false, error: out.error });

    if (out.refunded) {
      const back = await sbRpc('topup_refund_v1', {
        p: { provider: prov, ext_id: out.ext_id },
      });
      return res.status(200).json(back);
    }

    if (!out.player) {
      // Деньги пришли, а чьи — непонятно. Не теряем: видно в записях
      // Vercel, зачисляется потом одной строкой руками.
      return res.status(200).json({ ok: false, error: 'no_player', ext_id: out.ext_id });
    }

    const done = await sbRpc('topup_card_v1', {
      p: { provider: prov, ext_id: out.ext_id, wallet: out.player, cents: out.cents },
    });
    return res.status(200).json(done);
  } catch (e) {
    console.log('[paid] упало: ' + String(e && e.message || e));
    // Отвечаем 200, иначе контора будет долбить одним и тем же письмом.
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
};
