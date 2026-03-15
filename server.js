require('dotenv').config();
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sumsubArchiveHandler = require('./api/sumsub/archive');

const port = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const indexPath = path.join(publicDir, 'index.html');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const resendApiKey = process.env.RESEND_API_KEY;
const orderbookEmailFrom = process.env.ORDERBOOK_EMAIL_FROM;
const orderbookEmailTo = process.env.ORDERBOOK_EMAIL_TO;
const orderbookDailyAmHour = Number(process.env.ORDERBOOK_DAILY_AM_HOUR || 15);
const orderbookDailyAmMinute = Number(process.env.ORDERBOOK_DAILY_AM_MINUTE || 30);
const orderbookEnableIntervalScheduler = String(process.env.ORDERBOOK_ENABLE_INTERVAL_SCHEDULER || '').toLowerCase() === 'true';
let lastDailyOrderbookEmailDateKey = '';

const sendJson = (res, statusCode, body) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const parseBearerToken = (authorizationHeader) => {
  if (!authorizationHeader || typeof authorizationHeader !== 'string') return null;
  if (!authorizationHeader.startsWith('Bearer ')) return null;
  return authorizationHeader.slice('Bearer '.length).trim() || null;
};

const readJsonBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1024 * 1024) {
      reject(new Error('Payload too large'));
      req.destroy();
    }
  });

  req.on('end', () => {
    try {
      const parsed = body ? JSON.parse(body) : {};
      resolve(parsed);
    } catch (error) {
      reject(new Error('Invalid JSON body'));
    }
  });

  req.on('error', (error) => {
    reject(error);
  });
});

const sendOrderbookCsvEmail = async ({ subject, csvContent, fileName }) => {
  if (!resendApiKey || !orderbookEmailFrom || !orderbookEmailTo) {
    throw new Error('Email service not configured. Set RESEND_API_KEY, ORDERBOOK_EMAIL_FROM, ORDERBOOK_EMAIL_TO');
  }

  const safeFileName = String(fileName || 'order-book.csv');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: orderbookEmailFrom,
      to: [orderbookEmailTo],
      subject: subject || 'Order Book CSV',
      text: 'Attached is the latest order book CSV.',
      attachments: [
        {
          filename: safeFileName,
          content: Buffer.from(String(csvContent || ''), 'utf8').toString('base64')
        }
      ]
    })
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || `Resend request failed with ${response.status}`;
    throw new Error(message);
  }

  return payload;
};

const toOrderbookCsvContent = (rows) => {
  const normalizeCsv = (value) => {
    const base = String(value ?? '');
    return `"${base.replace(/"/g, '""')}"`;
  };

  const header = ['Line', 'Instrument Name', 'Ticker', 'ISIN', 'Side', 'Total Quantity', 'Order Type', 'Settlement Account', 'Broker Ref'];
  const csvLines = [header.map(normalizeCsv).join(',')];

  rows.forEach((row) => {
    csvLines.push([
      row.line,
      row.instrumentName,
      row.ticker,
      row.isin,
      row.side,
      row.totalQuantity,
      row.orderType,
      row.settlementAccount,
      row.brokerRef
    ].map(normalizeCsv).join(','));
  });

  return csvLines.join('\n');
};

const buildDailySnapshotRows = (holdings, securitiesRows) => {
  const securitiesMap = {};
  securitiesRows.forEach((security) => {
    securitiesMap[security.id] = security;
  });

  return (holdings || []).map((row, index) => {
    const security = securitiesMap[row.security_id] || {};
    const quantityValue = Number(row.quantity);
    const isQuantityNumeric = Number.isFinite(quantityValue);

    return {
      line: index + 1,
      instrumentName: security.name || '-',
      ticker: security.symbol ?? '-',
      isin: security.isin ?? security.ISIN ?? security.isin_code ?? security.isincode ?? '-',
      side: isQuantityNumeric ? (quantityValue < 0 ? 'SELL' : 'BUY') : '-',
      totalQuantity: isQuantityNumeric
        ? quantityValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })
        : (row.quantity ?? '-'),
      orderType: 'Market',
      settlementAccount: '',
      brokerRef: ''
    };
  });
};

const sendDailyOrderbookSnapshotEmail = async () => {
  const holdings = await fetchSupabaseJson(
    '/rest/v1/stock_holdings?select=id,user_id,security_id,quantity,avg_fill,market_value,unrealized_pnl,as_of_date,created_at,updated_at,%22Status%22,%22Fill_date%22,%22Exit_date%22,avg_exit&order=updated_at.desc',
    null
  );

  const securityIds = [...new Set((holdings || []).map((row) => row.security_id).filter(Boolean))];
  const securitiesRows = securityIds.length ? await loadSecuritiesByIds(securityIds, null) : [];
  const rows = buildDailySnapshotRows(holdings || [], securitiesRows || []);
  const now = new Date();
  const dateLabel = now.toLocaleString();

  await sendOrderbookCsvEmail({
    subject: `Daily Order Book - ${dateLabel}`,
    csvContent: toOrderbookCsvContent(rows),
    fileName: `daily-orderbook-${now.toISOString().slice(0, 10)}.csv`
  });
};

const maybeRunDailyOrderbookScheduler = async () => {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const currentMinuteOfDay = (hours * 60) + minutes;
  const targetMinuteOfDay = (orderbookDailyAmHour * 60) + orderbookDailyAmMinute;
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  if (currentMinuteOfDay < targetMinuteOfDay) {
    return;
  }

  if (lastDailyOrderbookEmailDateKey === dateKey) {
    return;
  }

  lastDailyOrderbookEmailDateKey = dateKey;

  try {
    await sendDailyOrderbookSnapshotEmail();
    console.log(`[OrderbookScheduler] Daily CSV sent for ${dateKey} at ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`);
  } catch (error) {
    console.error('[OrderbookScheduler] Daily CSV send failed:', error?.message || error);
  }
};

const startDailyOrderbookScheduler = () => {
  setInterval(() => {
    maybeRunDailyOrderbookScheduler();
  }, 30000);

  maybeRunDailyOrderbookScheduler();
};

const fetchSupabaseJson = async (path, token, useServiceRoleAuth = true) => {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Supabase server credentials are not configured');
  }

  const url = `${supabaseUrl}${path}`;
  const authToken = useServiceRoleAuth ? supabaseServiceRoleKey : token;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'apikey': supabaseServiceRoleKey,
      'Authorization': `Bearer ${authToken}`,
      'Accept': 'application/json'
    }
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || `Supabase request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload;
};

const buildInFilter = (values) => values
  .map((value) => encodeURIComponent(String(value)))
  .join(',');

const loadSecuritiesByIds = async (securityIds, token) => {
  const variants = [
    'id,name,symbol,isin',
    'id,name,symbol,%22ISIN%22',
    'id,name,symbol,isin_code',
    'id,name,symbol,isincode',
    'id,name,symbol'
  ];

  let lastError = null;
  for (const selectClause of variants) {
    try {
      const rows = await fetchSupabaseJson(
        `/rest/v1/securities?select=${selectClause}&id=in.(${buildInFilter(securityIds)})`,
        token
      );
      return rows || [];
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return [];
};

const buildOrderbookRows = (holdings, securitiesRows, profileRows) => {
  const securitiesMap = {};
  const profilesMap = {};

  securitiesRows.forEach((security) => {
    securitiesMap[security.id] = security;
  });

  profileRows.forEach((profile) => {
    profilesMap[profile.id] = profile;
  });

  return holdings.map((row, index) => {
    const security = securitiesMap[row.security_id] || {};
    const profile = profilesMap[row.user_id] || {};
    const instrumentName = security.name || '-';
    const ticker = security.symbol ?? '-';
    const isin = security.isin ?? security.ISIN ?? security.isin_code ?? security.isincode ?? '-';
    const timestamp = row.updated_at || row.created_at || row.as_of_date || null;
    const clientName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || String(row.user_id || 'Unknown client');
    const settlementAccount = profile.email || `${clientName} Main`;
    const settlementAccountOptions = [...new Set([
      settlementAccount,
      `${clientName} Main`,
      `${clientName} Trading`
    ].filter(Boolean))];
    const brokerRef = row.id ? `SH-${String(row.id).slice(0, 8)}` : (row.security_id ? `BR-${row.security_id}` : `BR-${index + 1}`);
    const brokerRefOptions = [...new Set([
      brokerRef,
      `${brokerRef}-A`,
      `${brokerRef}-B`
    ].filter(Boolean))];
    const quantityValue = Number(row.quantity);
    const isQuantityNumeric = Number.isFinite(quantityValue);
    const side = isQuantityNumeric
      ? (quantityValue < 0 ? 'SELL' : 'BUY')
      : '-';
    const statusText = String(row.Status || '').trim();
    const orderType = statusText
      || (row.Exit_date ? 'CLOSED' : (row.Fill_date ? 'FILLED' : 'OPEN'));
    const totalQuantity = isQuantityNumeric
      ? quantityValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })
      : (row.quantity ?? '-');

    return {
      line: index + 1,
      instrumentName,
      ticker,
      isin,
      side,
      totalQuantity,
      orderType,
      settlementAccount,
      settlementAccountOptions,
      brokerRef,
      brokerRefOptions,
      timestamp
    };
  });
};

const getSumsubAuthHeaders = (method, pathWithQuery) => {
  const appToken = process.env.SUMSUB_APP_TOKEN;
  const appSecret = process.env.SUMSUB_APP_SECRET;
  if (!appToken || !appSecret) {
    return null;
  }
  const ts = Math.floor(Date.now() / 1000).toString();
  const signaturePayload = ts + method + pathWithQuery;
  const signature = crypto
    .createHmac('sha256', appSecret)
    .update(signaturePayload)
    .digest('hex');

  return {
    'Accept': 'application/json',
    'X-App-Token': appToken,
    'X-App-Access-Sig': signature,
    'X-App-Access-Ts': ts
  };
};

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/mandate-data') && req.method === 'GET') {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }
    (async () => {
      try {
        await fetchSupabaseJson('/auth/v1/user', token, false);
        const profileId = new URL(req.url, 'http://localhost').searchParams.get('profileId');
        if (!profileId) {
          sendJson(res, 400, { error: 'Missing profileId parameter' });
          return;
        }
        const rows = await fetchSupabaseJson(
          `/rest/v1/user_onboarding?select=sumsub_raw&user_id=eq.${encodeURIComponent(profileId)}&limit=1`,
          token
        );
        const row = Array.isArray(rows) ? rows[0] : null;
        const raw = row?.sumsub_raw;
        const mandateData = (raw && typeof raw === 'object' ? raw : {}).mandate_data || null;
        sendJson(res, 200, { mandate_data: mandateData });
      } catch (err) {
        sendJson(res, 500, { error: err.message || 'Failed to fetch mandate data' });
      }
    })();
    return;
  }

  if (req.url.startsWith('/api/orderbook/send-csv') && req.method === 'POST') {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }

    (async () => {
      try {
        await fetchSupabaseJson('/auth/v1/user', token, false);
        const body = await readJsonBody(req);
        await sendOrderbookCsvEmail({
          subject: body?.subject,
          csvContent: body?.csvContent,
          fileName: body?.fileName
        });
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, {
          error: 'Could not send orderbook CSV email',
          details: error?.message || 'Unknown error'
        });
      }
    })();

    return;
  }

  if (req.url.startsWith('/api/orderbook')) {
    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      sendJson(res, 401, { error: 'Missing Authorization bearer token' });
      return;
    }

    (async () => {
      try {
        await fetchSupabaseJson('/auth/v1/user', token, false);

        const holdings = await fetchSupabaseJson(
          '/rest/v1/stock_holdings?select=id,user_id,security_id,quantity,avg_fill,market_value,unrealized_pnl,as_of_date,created_at,updated_at,%22Status%22,%22Fill_date%22,%22Exit_date%22,avg_exit&order=updated_at.desc',
          token
        );

        const securityIds = [...new Set((holdings || []).map((row) => row.security_id).filter(Boolean))];
        const userIds = [...new Set((holdings || []).map((row) => row.user_id).filter(Boolean))];

        const securitiesRows = securityIds.length ? await loadSecuritiesByIds(securityIds, token) : [];
        const profileRows = userIds.length
          ? await fetchSupabaseJson(
            `/rest/v1/profiles?select=id,first_name,last_name,email,phone_number,mint_number&id=in.(${buildInFilter(userIds)})`,
            token
          )
          : [];

        const rows = buildOrderbookRows(holdings || [], securitiesRows || [], profileRows || []);
        sendJson(res, 200, { rows });
      } catch (error) {
        sendJson(res, 500, {
          error: 'Could not load orderbook data',
          details: error?.message || 'Unknown error'
        });
      }
    })();

    return;
  }

  if (req.url.startsWith('/api/sumsub/applicant')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const externalUserId = url.searchParams.get('externalUserId');
    if (!externalUserId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'externalUserId is required' }));
      return;
    }

    const method = 'GET';
    const pathWithQuery = `/resources/applicants/-;externalUserId=${encodeURIComponent(externalUserId)}/one`;
    const headers = getSumsubAuthHeaders(method, pathWithQuery);
    if (!headers) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Sumsub credentials are not configured' }));
      return;
    }

    const options = {
      hostname: 'api.sumsub.com',
      path: pathWithQuery,
      method,
      headers: {
        ...headers
      }
    };

    const sumsubReq = https.request(options, (sumsubRes) => {
      let data = '';
      sumsubRes.on('data', (chunk) => {
        data += chunk;
      });
      sumsubRes.on('end', () => {
        res.writeHead(sumsubRes.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(data);
      });
    });

    sumsubReq.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Sumsub request failed', details: err.message }));
    });

    sumsubReq.end();
    return;
  }

  if (req.url.startsWith('/api/sumsub/metadata')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const applicantId = url.searchParams.get('applicantId');
    if (!applicantId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'applicantId is required' }));
      return;
    }

    const method = 'GET';
    const pathWithQuery = `/resources/applicants/${encodeURIComponent(applicantId)}/metadata/resources`;
    const headers = getSumsubAuthHeaders(method, pathWithQuery);
    if (!headers) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Sumsub credentials are not configured' }));
      return;
    }

    const options = {
      hostname: 'api.sumsub.com',
      path: pathWithQuery,
      method,
      headers
    };

    const sumsubReq = https.request(options, (sumsubRes) => {
      let data = '';
      sumsubRes.on('data', (chunk) => {
        data += chunk;
      });
      sumsubRes.on('end', () => {
        res.writeHead(sumsubRes.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(data);
      });
    });

    sumsubReq.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Sumsub request failed', details: err.message }));
    });

    sumsubReq.end();
    return;
  }

  if (req.url.startsWith('/api/sumsub/image')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const inspectionId = url.searchParams.get('inspectionId');
    const imageId = url.searchParams.get('imageId');
    if (!inspectionId || !imageId) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'inspectionId and imageId are required' }));
      return;
    }

    const method = 'GET';
    const pathWithQuery = `/resources/inspections/${encodeURIComponent(inspectionId)}/resources/${encodeURIComponent(imageId)}`;
    const headers = getSumsubAuthHeaders(method, pathWithQuery);
    if (!headers) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Sumsub credentials are not configured' }));
      return;
    }

    const options = {
      hostname: 'api.sumsub.com',
      path: pathWithQuery,
      method,
      headers
    };

    const sumsubReq = https.request(options, (sumsubRes) => {
      res.writeHead(sumsubRes.statusCode || 500, {
        'Content-Type': sumsubRes.headers['content-type'] || 'application/octet-stream'
      });
      sumsubRes.pipe(res);
    });

    sumsubReq.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Sumsub request failed', details: err.message }));
    });

    sumsubReq.end();
    return;
  }

  if (req.url.startsWith('/api/sumsub/archive')) {
    (async () => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        req.query = Object.fromEntries(url.searchParams.entries());

        if (req.method === 'POST') {
          req.body = await readJsonBody(req);
        }

        await sumsubArchiveHandler(req, res);
      } catch (error) {
        sendJson(res, 500, {
          error: 'Could not handle sumsub archive request',
          details: error?.message || 'Unknown error'
        });
      }
    })();
    return;
  }

  const requestPath = req.url === '/' ? '/index.html' : req.url;
  const safePath = path.normalize(requestPath).replace(/^([/\\])+/, '');
  const filePath = path.join(publicDir, safePath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  if (orderbookEnableIntervalScheduler) {
    startDailyOrderbookScheduler();
  }
});
