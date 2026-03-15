const sendJson = (res, statusCode, body) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
};

const requestSupabaseJson = async (path, options = {}) => {
  const {
    method = 'GET',
    token = null,
    useServiceRoleAuth = true,
    body = null,
    extraHeaders = {}
  } = options;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Supabase server credentials are not configured');
  }

  const authToken = useServiceRoleAuth ? supabaseServiceRoleKey : token;
  if (!authToken) {
    throw new Error('Auth token missing');
  }

  const response = await fetch(`${supabaseUrl}${path}`, {
    method,
    headers: {
      'apikey': supabaseServiceRoleKey,
      'Authorization': `Bearer ${authToken}`,
      'Accept': 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders
    },
    ...(body ? { body: JSON.stringify(body) } : {})
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

const fetchSupabaseJson = async (path, token = null, useServiceRoleAuth = true) => {
  return requestSupabaseJson(path, {
    method: 'GET',
    token,
    useServiceRoleAuth
  });
};

const buildInFilter = (values) => values
  .map((value) => encodeURIComponent(String(value)))
  .join(',');

const loadSecuritiesByIds = async (securityIds) => {
  const rows = await fetchSupabaseJson(
    `/rest/v1/securities?select=id,name,symbol,isin&id=in.(${buildInFilter(securityIds)})`
  );
  return rows || [];
};

const buildOrderbookRows = (holdings, securitiesRows) => {
  const securitiesMap = {};
  securitiesRows.forEach((security) => {
    securitiesMap[security.id] = security;
  });

  return (holdings || []).map((row, index) => {
    const security = securitiesMap[row.security_id] || {};
    const quantityValue = Number(row.quantity);
    const isQuantityNumeric = Number.isFinite(quantityValue);
    const marketValueNumber = Number(row.market_value);
    const hasMarketValue = Number.isFinite(marketValueNumber);

    return {
      line: index + 1,
      instrumentName: security.name || '-',
      ticker: security.symbol ?? '-',
      isin: security.isin ?? '-',
      side: isQuantityNumeric ? (quantityValue < 0 ? 'SELL' : 'BUY') : '-',
      totalQuantity: isQuantityNumeric
        ? quantityValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 })
        : (row.quantity ?? '-'),
      marketValueNumber: hasMarketValue ? marketValueNumber : 0,
      marketValue: hasMarketValue
        ? `R ${marketValueNumber.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '-',
      orderType: 'Market',
      settlementAccount: '',
      brokerRef: ''
    };
  });
};

const toOrderbookCsvContent = (rows) => {
  const normalizeCsv = (value) => {
    const base = String(value ?? '');
    return `"${base.replace(/"/g, '""')}"`;
  };

  const header = ['Line', 'Instrument Name', 'Ticker', 'ISIN', 'Side', 'Total Quantity', 'Order Type', 'Settlement Account', 'Broker Ref'];
  const csvLines = [header.map(normalizeCsv).join(',')];

  (rows || []).forEach((row) => {
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

const sendOrderbookCsvEmail = async ({ subject, csvContent, fileName, idempotencyKey }) => {
  const resendApiKey = process.env.RESEND_API_KEY;
  const orderbookEmailFrom = process.env.ORDERBOOK_EMAIL_FROM;
  const orderbookEmailTo = process.env.ORDERBOOK_EMAIL_TO;

  if (!resendApiKey || !orderbookEmailFrom || !orderbookEmailTo) {
    throw new Error('Email service not configured. Set RESEND_API_KEY, ORDERBOOK_EMAIL_FROM, ORDERBOOK_EMAIL_TO');
  }

  const recipients = String(orderbookEmailTo)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {})
    },
    body: JSON.stringify({
      from: orderbookEmailFrom,
      to: recipients,
      subject: subject || 'Order Book CSV',
      text: 'Attached is the latest order book CSV.',
      attachments: [
        {
          filename: String(fileName || 'order-book.csv'),
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

const loadLiveOrderbookRows = async (sinceIso = null) => {
  const sinceFilter = sinceIso
    ? `&updated_at=gt.${encodeURIComponent(String(sinceIso))}`
    : '';

  const holdings = await fetchSupabaseJson(
    `/rest/v1/stock_holdings?select=id,user_id,security_id,quantity,avg_fill,market_value,unrealized_pnl,as_of_date,created_at,updated_at,%22Status%22,%22Fill_date%22,%22Exit_date%22,avg_exit,strategy_id&order=updated_at.desc${sinceFilter}`
  );

  const securityIds = [...new Set((holdings || []).map((row) => row.security_id).filter(Boolean))];
  const securitiesRows = securityIds.length ? await loadSecuritiesByIds(securityIds) : [];
  return buildOrderbookRows(holdings || [], securitiesRows || []);
};

module.exports = {
  sendJson,
  requestSupabaseJson,
  fetchSupabaseJson,
  buildInFilter,
  toOrderbookCsvContent,
  sendOrderbookCsvEmail,
  loadLiveOrderbookRows
};
