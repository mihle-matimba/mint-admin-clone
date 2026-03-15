const crypto = require('crypto');

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

const jsonError = (res, status, message) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
};

module.exports = {
  getSumsubAuthHeaders,
  jsonError
};
