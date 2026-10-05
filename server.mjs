import { createServer as createViteServer } from 'vite';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const isProduction = process.argv.includes('--production');
const env = await readLocalEnv();
const port = Number(process.env.PORT ?? env.PORT ?? 4173);
const managementKey = process.env.OPENROUTER_MANAGEMENT_KEY ?? env.OPENROUTER_MANAGEMENT_KEY ?? '';
const apiRoot = 'https://openrouter.ai/api/v1';
let modelNameCache = { expiresAt: 0, names: new Map() };

async function getModelNames() {
  if (Date.now() < modelNameCache.expiresAt) return modelNameCache.names;
  try {
    const response = await fetch(`${apiRoot}/models`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload?.data) ? payload.data : [];
    const names = new Map();
    for (const model of models) {
      if (!model?.id || !model?.name) continue;
      const id = String(model.id);
      names.set(id, String(model.name));
      names.set(id.toLowerCase(), String(model.name));
    }
    modelNameCache = { expiresAt: Date.now() + 6 * 60 * 60 * 1000, names };
  } catch {
    modelNameCache = { ...modelNameCache, expiresAt: Date.now() + 60 * 1000 };
  }
  return modelNameCache.names;
}

function displayModelName(value, modelNames) {
  const id = String(value ?? 'Unknown model');
  const catalogName = modelNames.get(id) ?? modelNames.get(id.toLowerCase());
  if (catalogName) return catalogName;

  const shortName = id.replace(/^[^/]+\//, '').replace(/-\d+(?:-\d+)*$/, '');
  return shortName.replace(/(^|[-\s])([a-z])/g, (_, separator, letter) => `${separator}${letter.toUpperCase()}`);
}

async function readLocalEnv() {
  try {
    const contents = await readFile(join(root, '.env'), 'utf8');
    return Object.fromEntries(contents.split(/\r?\n/).flatMap(line => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      return match ? [[match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]] : [];
    }));
  } catch {
    return {};
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function decodeRows(payload) {
  return payload?.data?.data ?? payload?.data ?? [];
}

function findMetric(metrics, candidates, pattern) {
  for (const candidate of candidates) {
    const found = metrics.find(metric => metric.name === candidate);
    if (found) return found.name;
  }
  return metrics.find(metric => pattern.test(`${metric.name} ${metric.display_label}`))?.name;
}

function findDimension(dimensions, candidates, pattern) {
  for (const candidate of candidates) {
    const found = dimensions.find(dimension => dimension.name === candidate);
    if (found) return found.name;
  }
  return dimensions.find(dimension => pattern.test(`${dimension.name} ${dimension.display_label}`))?.name;
}

async function openRouter(path, options = {}) {
  const response = await fetch(`${apiRoot}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${managementKey}`,
      'content-type': 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message ?? `OpenRouter returned HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function queryAnalytics(metrics, dimensions, start, end, granularity, limit = 100) {
  if (!metrics.length) return [];
  const payload = await openRouter('/analytics/query', {
    method: 'POST',
    body: JSON.stringify({
      metrics,
      dimensions: dimensions?.length ? dimensions : undefined,
      granularity,
      time_range: { start, end },
      limit,
      order_by: metrics.length ? { field: metrics[0], direction: 'desc' } : undefined,
    }),
  });
  return decodeRows(payload);
}

function timeWindow(range) {
  const end = new Date();
  const hours = range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30;
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  return {
    start: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    end: end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    granularity: range === '24h' ? 'hour' : 'day',
  };
}

async function dashboardData(range) {
  const { start, end, granularity } = timeWindow(range);
  const [[creditsSettled, keySettled, metaSettled, keysSettled], modelNames] = await Promise.all([
    Promise.allSettled([
      openRouter('/credits'),
      openRouter('/auth/key'),
      openRouter('/analytics/meta'),
      openRouter('/keys?offset=0'),
    ]),
    getModelNames(),
  ]);

  const requiredFailure = [creditsSettled, metaSettled].find(result => result.status === 'rejected');
  if (requiredFailure) throw requiredFailure.reason;

  const credits = creditsSettled.value?.data ?? {};
  const keyInfo = keySettled.status === 'fulfilled' ? keySettled.value?.data ?? {} : {};
  const meta = metaSettled.value?.data ?? {};
  const availableMetrics = meta.metrics ?? [];
  const availableDimensions = meta.dimensions ?? [];

  const spend = findMetric(availableMetrics, ['total_usage', 'usage', 'total_cost'], /total.?usage|total.?spend|total.?cost/i);
  const requestCount = findMetric(availableMetrics, ['request_count'], /request.?count/i);
  const totalTokens = findMetric(availableMetrics, ['tokens_total', 'total_tokens'], /total.?tokens|tokens.?total/i);
  const promptTokens = findMetric(availableMetrics, ['prompt_tokens', 'tokens_prompt'], /prompt.*tokens|tokens.*prompt/i);
  const completionTokens = findMetric(availableMetrics, ['completion_tokens', 'tokens_completion'], /completion.*tokens|tokens.*completion/i);
  const reasoningTokens = findMetric(availableMetrics, ['reasoning_tokens', 'tokens_reasoning'], /reasoning.*tokens|tokens.*reasoning/i);
  const cacheHitRate = findMetric(availableMetrics, ['cache_hit_rate'], /cache.*hit.*rate/i);
  const modelDimension = findDimension(availableDimensions, ['model'], /model/i);
  const keyDimension = findDimension(availableDimensions, ['api_key_id', 'api_key'], /api.?key/i);

  const summaryMetrics = [spend, requestCount, totalTokens, cacheHitRate].filter(Boolean);
  const modelTrendMetrics = [
    spend,
    totalTokens,
    ...(totalTokens ? [] : [promptTokens, completionTokens, reasoningTokens]),
  ].filter(Boolean);
  const metricTrendMetrics = [...new Set([
    spend,
    requestCount,
    totalTokens,
    cacheHitRate,
    ...(totalTokens ? [] : [promptTokens, completionTokens]),
  ].filter(Boolean))];
  const breakdownMetrics = [promptTokens, completionTokens, reasoningTokens].filter(Boolean);
  const [summary, models, keys, trend, breakdown, metricTrend] = await Promise.all([
    queryAnalytics(summaryMetrics, [], start, end, undefined, 1),
    modelDimension ? queryAnalytics([spend, totalTokens].filter(Boolean), [modelDimension], start, end, undefined, 12) : Promise.resolve([]),
    completionTokens && keyDimension ? queryAnalytics([completionTokens], [keyDimension], start, end, undefined, 8) : Promise.resolve([]),
    modelDimension && modelTrendMetrics.length ? queryAnalytics(modelTrendMetrics, [modelDimension], start, end, granularity, 300) : Promise.resolve([]),
    queryAnalytics(breakdownMetrics, [], start, end, undefined, 1),
    queryAnalytics(metricTrendMetrics, [], start, end, granularity, 300),
  ]);

  const keyRows = keysSettled.status === 'fulfilled' ? keysSettled.value?.data ?? [] : [];
  const keyMap = new Map();
  for (const key of keyRows) {
    const name = key.name ?? 'Unnamed key';
    for (const identifier of [key.hash, key.id, key.key_id]) {
      if (identifier == null) continue;
      const id = String(identifier);
      keyMap.set(id, name);
      keyMap.set(id.toLowerCase(), name);
    }
  }
  const summaryRow = summary[0] ?? {};
  const breakdownRow = breakdown[0] ?? {};
  const fallbackTokenTotal = (promptTokens ? Number(breakdownRow[promptTokens] ?? 0) : 0)
    + (completionTokens ? Number(breakdownRow[completionTokens] ?? 0) : reasoningTokens ? Number(breakdownRow[reasoningTokens] ?? 0) : 0);

  return {
    range,
    updatedAt: new Date().toISOString(),
    account: {
      label: keyInfo.label ?? keyInfo.name ?? 'OpenRouter account',
      isManagementKey: keyInfo.is_management_key ?? null,
      limit: keyInfo.limit ?? null,
      usage: keyInfo.usage ?? null,
    },
    credits: {
      total: Number(credits.total_credits ?? 0),
      used: Number(credits.total_usage ?? 0),
      remaining: Math.max(0, Number(credits.total_credits ?? 0) - Number(credits.total_usage ?? 0)),
    },
    metrics: {
      spend: spend ? Number(summaryRow[spend] ?? 0) : null,
      requests: requestCount ? Number(summaryRow[requestCount] ?? 0) : null,
      tokens: totalTokens ? Number(summaryRow[totalTokens] ?? 0) : breakdownMetrics.length ? fallbackTokenTotal : null,
      cacheHitRate: cacheHitRate ? Number(summaryRow[cacheHitRate] ?? 0) : null,
    },
    metricNames: { spend, requestCount, totalTokens, promptTokens, completionTokens, reasoningTokens, cacheHitRate },
    models: models.map(row => ({
      name: displayModelName(row[modelDimension], modelNames),
      spend: spend ? Number(row[spend] ?? 0) : 0,
      tokens: totalTokens ? Number(row[totalTokens] ?? 0) : 0,
    })).sort((a, b) => b.spend - a.spend),
    keys: keys.map(row => {
      const id = String(row[keyDimension] ?? '');
      const name = keyMap.get(id) ?? keyMap.get(id.toLowerCase()) ?? (id || 'Unlabeled key');
      return { name, tokens: completionTokens ? Number(row[completionTokens] ?? 0) : 0 };
    }).sort((a, b) => b.tokens - a.tokens),
    trend: trend.map(row => ({
      date: row.date__hour ?? row.date__day ?? row.date ?? '',
      spend: spend ? Number(row[spend] ?? 0) : null,
      tokens: totalTokens
        ? Number(row[totalTokens] ?? 0)
        : (promptTokens ? Number(row[promptTokens] ?? 0) : 0)
          + (completionTokens ? Number(row[completionTokens] ?? 0) : reasoningTokens ? Number(row[reasoningTokens] ?? 0) : 0),
      model: modelDimension ? displayModelName(row[modelDimension], modelNames) : 'Other',
    })),
    metricTrend: metricTrend.map(row => ({
      date: row.date__hour ?? row.date__day ?? row.date ?? '',
      spend: spend ? Number(row[spend] ?? 0) : null,
      requests: requestCount ? Number(row[requestCount] ?? 0) : null,
      tokens: totalTokens
        ? Number(row[totalTokens] ?? 0)
        : breakdownMetrics.length
          ? (promptTokens ? Number(row[promptTokens] ?? 0) : 0) + (completionTokens ? Number(row[completionTokens] ?? 0) : 0)
          : null,
      cacheHitRate: cacheHitRate ? Number(row[cacheHitRate] ?? 0) : null,
    })).sort((a, b) => a.date.localeCompare(b.date)),
    breakdown: {
      prompt: promptTokens ? Number(breakdownRow[promptTokens] ?? 0) : null,
      completion: completionTokens ? Number(breakdownRow[completionTokens] ?? 0) : null,
      reasoning: reasoningTokens ? Number(breakdownRow[reasoningTokens] ?? 0) : null,
    },
    capabilities: { modelDimension: Boolean(modelDimension), keyDimension: Boolean(keyDimension) },
  };
}

async function handleApi(request, response, url) {
  if (!managementKey) {
    sendJson(response, 503, { error: 'Add your OpenRouter Management API key to .env, then restart the dashboard.' });
    return;
  }
  if (url.pathname === '/api/dashboard' && request.method === 'GET') {
    const range = ['24h', '7d', '30d'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : '24h';
    try {
      sendJson(response, 200, await dashboardData(range));
    } catch (error) {
      sendJson(response, error.status === 401 || error.status === 403 ? error.status : 502, {
        error: error.status === 401 || error.status === 403
          ? 'This key is invalid or lacks Management API permissions. Create a Management API key and update .env.'
          : `Could not load OpenRouter analytics: ${error.message}`,
      });
    }
    return;
  }
  sendJson(response, 404, { error: 'Not found' });
}

const vite = isProduction ? null : await createViteServer({
  configFile: join(root, 'vite.config.ts'),
  server: { middlewareMode: true },
  appType: 'spa',
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(request, response, url);
  if (vite) {
    vite.middlewares(request, response, error => {
      if (error) {
        response.statusCode = 500;
        response.end(error.message);
      }
    });
    return;
  }
  try {
    const dist = join(root, 'dist');
    const requested = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '');
    let file = join(dist, requested || 'index.html');
    try { await stat(file); } catch { file = join(dist, 'index.html'); }
    const body = await readFile(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'Build the app first with npm run build.' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`OpenRouter dashboard listening at http://127.0.0.1:${port}`);
  if (!managementKey) console.log('No Management API key configured. Add it to .env to load live data.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await vite?.close();
    server.close(() => process.exit(0));
  });
}
