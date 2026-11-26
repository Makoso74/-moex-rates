import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const CA_URL =
  'https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt';

const CA_SHA =
  'D26D2D0231B7C39F92CC738512BA54103519E4405D68B5BD703E9788CA8ECF31';

const SOURCE =
  'https://iss.moex.com/iss/engines/currency/markets/selt/' +
  'boards/CETS/securities/CNYRUB_TOM.json' +
  '?iss.meta=off&iss.only=marketdata,securities';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let trustedCA;

function get(url, ca) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { ...(ca ? { ca } : {}), timeout: 20000 },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          body += chunk;
          if (body.length > 2000000) {
            req.destroy(new Error('Response too large'));
          }
        });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode === 200) resolve(body);
          else reject(new Error('HTTP ' + res.statusCode));
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));

    const timer = setTimeout(
      () => req.destroy(new Error('Total timeout')),
      25000
    );
    req.on('close', () => clearTimeout(timer));
  });
}

function parse(text) {
  const data = JSON.parse(text);

  function field(block, key) {
    const b = data[block];
    const index = b?.columns?.indexOf(key);
    return index >= 0 ? b?.data?.[0]?.[index] : undefined;
  }

  if (field('securities', 'SECID') !== 'CNYRUB_TOM') {
    throw new Error('Unexpected instrument');
  }

  let rate;
  let priceType;

  for (const [block, key] of [
    ['marketdata', 'LAST'],
    ['marketdata', 'WAPRICE'],
    ['securities', 'PREVPRICE'],
  ]) {
    const value = field(block, key);
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value > 0
    ) {
      rate = value;
      priceType = key;
      break;
    }
  }

  if (!priceType) throw new Error('Rate missing');

  const sourceTimestamp = field('marketdata', 'SYSTIME') || null;
  const sourceDate = priceType === 'PREVPRICE'
    ? field('securities', 'PREVDATE')
    : String(sourceTimestamp || '').slice(0, 10);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(sourceDate || '') ||
    !Number.isFinite(Date.parse(sourceDate + 'T00:00:00Z'))
  ) {
    throw new Error('Source date missing');
  }

  const sourceTime = priceType === 'PREVPRICE'
    ? null
    : field(
        'marketdata',
        priceType === 'LAST' ? 'TIME' : 'UPDATETIME'
      ) || null;

  if (
    sourceTime &&
    !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(sourceTime)
  ) {
    throw new Error('Invalid source time');
  }

  return {
    schemaVersion: 1,
    source: 'MOEX ISS',
    instrument: 'CNYRUB_TOM',
    base: 'CNY',
    quote: 'RUB',
    rate,
    priceType,
    sourceDate,
    sourceTime,
    sourceTimezone: 'Europe/Moscow',
    sourceTimestamp,
    fetchedAt: new Date().toISOString(),
  };
}

async function collect() {
  if (!trustedCA) {
    const pem = await get(CA_URL);
    const fingerprint = new X509Certificate(pem)
      .fingerprint256.replaceAll(':', '');

    if (fingerprint !== CA_SHA) {
      throw new Error('Unexpected CA fingerprint');
    }

    trustedCA = [...tls.rootCertificates, pem];
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return parse(await get(SOURCE, trustedCA));
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(3000 * (attempt + 1));
    }
  }
  throw lastError;
}

function git(args, input) {
  return execFileSync('git', args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function publish(record) {
  const blob = git(
    ['hash-object', '-w', '--stdin'],
    JSON.stringify(record, null, 2) + '\n'
  );
  const tree = git(
    ['mktree'],
    '100644 blob ' + blob + '\tmoex.json\n'
  );
  const commit = git([
    'commit-tree',
    tree,
    '-m',
    'Update MOEX ' + record.fetchedAt,
  ]);

  // Ветка data содержит только последний снимок.
  git(['push', '--force', 'origin', commit + ':refs/heads/data']);
}

async function main() {
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify(await collect(), null, 2));
    return;
  }

  const started = Date.now();
  const duration = 330 * 60000;
  const interval = 300000;
  let lastKey = '';
  let lastPublished = 0;

  while (Date.now() - started < duration) {
    const roundStarted = Date.now();

    try {
      const record = await collect();
      const key = JSON.stringify([
        record.rate,
        record.priceType,
        record.sourceDate,
        record.sourceTime,
      ]);

      if (
        key !== lastKey ||
        Date.now() - lastPublished >= 900000
      ) {
        publish(record);
        lastKey = key;
        lastPublished = Date.now();
        console.log('Published:', JSON.stringify(record));
      } else {
        console.log('Unchanged');
      }
    } catch (error) {
      console.error(
        'Round failed; previous JSON preserved:',
        error.message
      );
    }

    const wait = Math.min(
      interval - (Date.now() - roundStarted),
      duration - (Date.now() - started)
    );
    if (wait > 0) await sleep(wait);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});