// Gate Territory — проверка перевода и зачисление на счёт.
//
// Телефон говорит только номер сделки. Всему остальному не верим:
// функция сама читает сделку в BNB Chain, сверяет адрес договора,
// достаёт номер игрока и сумму из события, берёт курс и зачисляет.
//
// Настройки Vercel: SUPABASE_KEY (тот же служебный ключ)

const SB_URL   = 'https://hgzthbidfdqomuotdocb.supabase.co';
// Два договора: один принимает монеты сети, второй — доллары.
const GATE_BNB = '0x7c9411a216a425ecaa7f0c1a9baa7554e4fce1bf';
const GATE_USD = '0xb6c1da2d079ab8fafc149cd74370567b57ab364b';
// keccak256("TopUp(bytes20,address,uint256,uint256)")
const TOPIC_BNB = '0x7c27a894d1e35dc322fcf63f2be24ee45364b39b95ce5b56c073b999a75c3324';
// keccak256("TopUpUSD(bytes20,address,uint256,uint256)")
const TOPIC_USD = '0xbfe0e565cfeafeec10a69df7b3e3e040ca83b7cbb1a24afe6c4957c951b46a7e';

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

// Курс BNB.
//
// РАНЬШЕ спрашивали ТОЛЬКО Binance и при отказе возвращали пустоту.
// А Binance закрывает доступ серверам из дата-центров — в том числе
// нашим. Курс приходил пустой, база отвечала bad_amount, и платёж не
// зачислялся НИКОГДА, хотя деньги уходили. Отсюда «оплатил и ничего».
//
// Теперь три биржи по очереди, потом запасное число из настроек базы,
// и только в самом конце — вшитое. Пустоту не возвращаем ни при каких
// обстоятельствах.
async function bnbUsd() {
  const tries = [
    ['https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT', j => parseFloat(j.price)],
    ['https://api.coinbase.com/v2/prices/BNB-USD/spot', j => parseFloat(j.data && j.data.amount)],
    ['https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd',
     j => parseFloat(j.binancecoin && j.binancecoin.usd)],
    ['https://api.kraken.com/0/public/Ticker?pair=BNBUSD',
     j => { const k = j.result && Object.keys(j.result)[0]; return k ? parseFloat(j.result[k].c[0]) : NaN; }],
  ];
  for (const [url, pick] of tries) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 4000);
      const r = await fetch(url, { signal: c.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const p = pick(await r.json());
      if (p > 50 && p < 5000) return p;        // защита от чепухи
    } catch (e) {}
  }
  // Биржи молчат — берём число, записанное в настройках игры.
  try {
    const r = await fetch(SB_URL + '/rest/v1/territory_config?key=eq.bnb_usd&select=value', {
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY },
    });
    if (r.ok) {
      const rows = await r.json();
      const p = rows && rows[0] && parseFloat(rows[0].value);
      if (p > 50 && p < 5000) return p;
    }
  } catch (e) {}
  return 600;                                  // последняя подпорка
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

    // ищем наше событие: от договора монет или от договора долларов
    const logs = r.logs || [];
    let log = logs.find(l => l.address.toLowerCase() === GATE_BNB && l.topics[0] === TOPIC_BNB);
    let isUsd = false;
    if (!log) {
      log = logs.find(l => l.address.toLowerCase() === GATE_USD && l.topics[0] === TOPIC_USD);
      isUsd = !!log;
    }
    if (!log) return res.status(200).json({ ok: false, error: 'not_our_topup' });

    // topics[1] — номер игрока. ВАЖНО: bytes20 дополняется нулями
    // СПРАВА, а не слева, как адрес. Берём первые 20 байт, иначе
    // получается мусор и деньги уходят в никуда.
    const player = '0x' + log.topics[1].slice(2, 42);
    const from = '0x' + log.topics[2].slice(-40);
    // data = amount (32 байта) + n (32 байта)
    const amount = BigInt('0x' + log.data.slice(2, 66)).toString();

    // Доллары считать не надо: единица монеты и есть доллар, курс = 1.
    // Для монет сети берём курс с биржи.
    const rate = isUsd ? 1 : await bnbUsd();
    const out = await sbRpc('topup_credit_v1', {
      p: { tx_hash: tx, wallet: player, from_addr: from, wei: amount,
           bnb_usd: rate, block_num: mined, kind: isUsd ? 'usd' : 'bnb' },
    });
    // Если база отказала — говорим ЧЕМ именно кормили. Без этого
    // приходится гадать, а гадать мы уже пробовали.
    if (!out || out.ok !== true) {
      return res.status(200).json(Object.assign({}, out, {
        sent: { wei: String(amount), bnb_usd: rate, kind: isUsd ? 'usd' : 'bnb',
                wallet: player },
      }));
    }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
};
