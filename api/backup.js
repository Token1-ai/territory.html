// Gate Territory — ежесуточная копия базы.
//
// Что делает: раз в сутки выгружает важные таблицы и кладёт их одним
// файлом в ЗАКРЫТЫЙ репозиторий на GitHub. Бесплатно, видно тебе,
// скачивается в один клик.
//
// Почему не в репозиторий с игрой: он открытый, а в выгрузке — данные
// игроков. Нужен отдельный, закрытый.
//
// Настройки Vercel:
//   SUPABASE_KEY   — служебный ключ (уже стоит)
//   BACKUP_REPO    — например Token1-ai/territory-backup
//   BACKUP_TOKEN   — ключ GitHub с правом записи в этот репозиторий
//   CRON_SECRET    — любая строка, чтобы посторонний не дёргал выгрузку

const zlib = require('zlib');

const SB_URL = 'https://hgzthbidfdqomuotdocb.supabase.co';

// Сколько ежесуточных копий держим. Старше — удаляем, иначе за год
// репозиторий раздуется до нескольких гигабайт.
const KEEP_DAILY = 14;

// Что выгружаем. Порядок важен только для чтения глазами.
const TABLES = [
  'territory_config',
  'territory_players',
  'territory_bunkers',
  'territory_units',
  'territory_names',
  'territory_clans',
  'territory_clan_members',
  'territory_sieges',
  'territory_siege_parts',
  'territory_inventory',
  'territory_topups',
  'territory_partners',
  'territory_partner_pct',
  'territory_prices',
  'territory_places',
  'territory_ads',
  'territory_items',
];

// Журнал событий берём только за последние 30 дней: он растёт быстрее
// всех, а старое уже посчитано в остатках.
const EVENTS_DAYS = 7;

async function sbGet(path) {
  const rows = [];
  const step = 1000;
  for (let from = 0; ; from += step) {
    const r = await fetch(SB_URL + '/rest/v1/' + path, {
      headers: {
        apikey: process.env.SUPABASE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_KEY,
        Range: `${from}-${from + step - 1}`,
      },
    });
    if (!r.ok) throw new Error(path + ' → ' + r.status);
    const part = await r.json();
    rows.push(...part);
    if (part.length < step) break;
    if (rows.length > 500000) break;           // предохранитель
  }
  return rows;
}

async function putToGitHub(pathInRepo, contentB64, message) {
  const repo = process.env.BACKUP_REPO;
  const api = `https://api.github.com/repos/${repo}/contents/${pathInRepo}`;
  const head = {
    Authorization: 'Bearer ' + process.env.BACKUP_TOKEN,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'gate-territory-backup',
  };
  // если файл за сегодня уже есть — перезапишем
  let sha;
  const cur = await fetch(api, { headers: head });
  if (cur.ok) { const j = await cur.json(); sha = j.sha; }

  const r = await fetch(api, {
    method: 'PUT',
    headers: head,
    body: JSON.stringify({ message, content: contentB64, sha }),
  });
  if (!r.ok) throw new Error('github ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return true;
}

// Удаляем копии старше KEEP_DAILY. Первое число месяца оставляем
// навсегда — так остаётся память на годы, а места почти не занимает.
async function pruneOld() {
  const repo = process.env.BACKUP_REPO;
  const head = {
    Authorization: 'Bearer ' + process.env.BACKUP_TOKEN,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gate-territory-backup',
  };
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/backups`, { headers: head });
  if (!r.ok) return 0;
  const list = await r.json();
  if (!Array.isArray(list)) return 0;
  const files = list
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json(\.gz)?$/.test(f.name))
    .sort((a, b) => (a.name < b.name ? 1 : -1));      // новые сверху
  let removed = 0;
  for (let i = KEEP_DAILY; i < files.length; i++) {
    const f = files[i];
    if (f.name.slice(8, 10) === '01') continue;        // первое число месяца бережём
    const d = await fetch(`https://api.github.com/repos/${repo}/contents/backups/${f.name}`, {
      method: 'DELETE',
      headers: { ...head, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'убрал старую копию ' + f.name, sha: f.sha }),
    });
    if (d.ok) removed++;
  }
  return removed;
}

module.exports = async (req, res) => {
  // Дёргать может только расписание Vercel или ты с ключом
  const key = req.headers['x-cron-secret'] || (req.query && req.query.key);
  const fromCron = req.headers['user-agent'] &&
                   String(req.headers['user-agent']).includes('vercel-cron');
  if (!fromCron && key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'not allowed' });
  }
  if (!process.env.SUPABASE_KEY || !process.env.BACKUP_REPO || !process.env.BACKUP_TOKEN) {
    return res.status(500).json({ error: 'not configured' });
  }

  const started = Date.now();
  const dump = { made_at: new Date().toISOString(), tables: {} };
  const counts = {};

  try {
    for (const t of TABLES) {
      const rows = await sbGet(t + '?select=*');
      dump.tables[t] = rows;
      counts[t] = rows.length;
    }
    const since = new Date(Date.now() - EVENTS_DAYS * 864e5).toISOString();
    const ev = await sbGet(`territory_events?select=*&at=gte.${since}`);
    dump.tables.territory_events = ev;
    counts.territory_events = ev.length;

    const json = JSON.stringify(dump);
    // Сжимаем: выгрузка ужимается примерно в десять раз.
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    const day = new Date().toISOString().slice(0, 10);
    const b64 = gz.toString('base64');

    await putToGitHub(`backups/${day}.json.gz`, b64,
                      `копия базы за ${day}: ${Object.values(counts).reduce((a, b) => a + b, 0)} строк`);

    const removed = await pruneOld();

    return res.status(200).json({
      ok: true,
      file: `backups/${day}.json.gz`,
      size_kb: Math.round(json.length / 1024),
      packed_kb: Math.round(gz.length / 1024),
      removed_old: removed,
      rows: counts,
      took_sec: Math.round((Date.now() - started) / 1000),
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e), rows: counts });
  }
};
