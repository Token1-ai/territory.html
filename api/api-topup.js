// Gate Territory — проверка перевода и зачисление на счёт.
//
// Телефон говорит только номер сделки. Всему остальному не верим:
// функция сама читает сделку в BNB Chain, сверяет адрес договора,
// достаёт номер игрока и сумму из события, берёт курс и зачисляет.
//
// Настройки Vercel: SUPABASE_KEY (тот же служебный ключ)

const SB_URL   = 'https://hgzthbidfdqomuotdocb.supabase.co';
const CONTRACT = '0x7c9411a216a425ecaa7f0c1a9baa7554e4fce1bf';
// keccak256("TopUp(bytes20,address,uint256,uint256)")
const TOPUP_TOPIC = '0x7c27a894d1e35dc322fcf63f2be24ee45364b39b95ce5b56c073b999a75c3324';

const RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://rpc.ankr.com/bsc',
];

async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error('all rpc failed');
}

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

// Курс берём у биржи. Не ответила — сервер возьмёт запасной из настроек.
async function bnbUsd() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT');
    const j = await r.json();
    const p = parseFloat(j.price);
    if (p > 50 && p < 5000) return p;          // защита от чепухи
  } catch (e) {}
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'post only' });
  if (!process.env.SUPABASE_KEY) return res.status(500).json({ error: 'not configured' });

  const tx = String((req.body && req.body.tx_hash) || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tx)) return res.status(400).json({ ok: false, error: 'bad_tx' });

  try {
    const r = await rpc('eth_getTransactionReceipt', [tx]);
    if (!r) return res.status(200).json({ ok: false, error: 'not_mined_yet' });
    if (r.status !== '0x1') return res.status(200).json({ ok: false, error: 'tx_failed' });

    // ждём подтверждений: иначе сделку могут откатить
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    const mined = parseInt(r.blockNumber, 16);
    const need = 3;
    if (head - mined < need) {
      return res.status(200).json({ ok: false, error: 'wait',
        confirms: head - mined, need });
    }

    // ищем наше событие от нашего договора
    const log = (r.logs || []).find(
      (l) => l.address.toLowerCase() === CONTRACT && l.topics[0] === TOPUP_TOPIC
    );
    if (!log) return res.status(200).json({ ok: false, error: 'not_our_topup' });

    // topics[1] — номер игрока. ВАЖНО: bytes20 дополняется нулями
    // СПРАВА, а не слева, как адрес. Берём первые 20 байт, иначе
    // получается мусор и деньги уходят в никуда.
    const player = '0x' + log.topics[1].slice(2, 42);
    const from = '0x' + log.topics[2].slice(-40);
    // data = amount (32 байта) + n (32 байта)
    const wei = BigInt('0x' + log.data.slice(2, 66)).toString();

    const rate = await bnbUsd();
    const out = await sbRpc('topup_credit_v1', {
      p: { tx_hash: tx, wallet: player, from_addr: from, wei,
           bnb_usd: rate, block_num: mined },
    });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
};
