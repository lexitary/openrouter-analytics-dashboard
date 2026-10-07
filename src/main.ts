import './style.css';

type Range = '24h' | '7d' | '30d';
type ChartMetric = 'spend' | 'tokens';
type MetricKey = 'credits' | 'spend' | 'requests' | 'tokens' | 'cacheHitRate';
type MetricTrendPoint = { date: string; spend: number | null; requests: number | null; tokens: number | null; cacheHitRate: number | null };
type DashboardData = {
  range: Range;
  updatedAt: string;
  account: { label: string; isManagementKey: boolean | null };
  credits: { total: number; used: number; remaining: number };
  metrics: { spend: number | null; requests: number | null; tokens: number | null; cacheHitRate: number | null };
  models: Array<{ name: string; spend: number; tokens: number }>;
  keys: Array<{ name: string; tokens: number }>;
  trend: Array<{ date: string; spend: number | null; tokens: number | null; model: string }>;
  metricTrend: MetricTrendPoint[];
  breakdown: { prompt: number | null; completion: number | null; reasoning: number | null };
  capabilities: { modelDimension: boolean; keyDimension: boolean };
};

const root = document.querySelector<HTMLElement>('#app')!;
const AUTO_REFRESH_MS = 15_000;
let range: Range = '24h';
let chartMetric: ChartMetric = 'spend';
let latest: DashboardData | null = null;
let loading = false;
let errorMessage = '';
let nextRefreshAt = Date.now() + AUTO_REFRESH_MS;

const icons = {
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  key: '<circle cx="8" cy="15" r="5"/><path d="m11.5 11.5 8-8L22 6l-3 3 2 2-3 3-2-2-3 3"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5c-.6-.8-1.6-1.2-3-1.2-1.7 0-2.8.8-2.8 2s.8 1.7 2.8 2.1 2.8 1 2.8 2.2-1.1 2.1-2.9 2.1c-1.4 0-2.5-.5-3.2-1.4M12.4 5.7v12.6"/>',
  tokens: '<path d="M12 3 4.5 7.5v9L12 21l7.5-4.5v-9L12 3Z"/><path d="m4.8 7.7 7.2 4.2 7.2-4.2M12 12v8.5"/>',
  requests: '<path d="M4 5h16M4 12h16M4 19h16"/><circle cx="8" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="10" cy="19" r="1"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 9a7 7 0 0 1 12-2l2 2M4 15l2 2a7 7 0 0 0 12-2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
};

function icon(name: keyof typeof icons, size = 18): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value < 1 ? 4 : 2 }).format(value);
}

function compact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function percent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value <= 1 ? value * 100 : value).toFixed(1)}%`;
}

function labelForRange(value: Range): string {
  return value === '24h' ? 'Past 24 hours' : value === '7d' ? 'Past 7 days' : 'Past 30 days';
}

function refreshCountdown(): string {
  return `Refresh in ${Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000))}s`;
}

function intervalKeys(updatedAt: string): string[] {
  const bucketMs = range === '24h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const rangeHours = range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30;
  const endMs = new Date(updatedAt).getTime();
  if (!Number.isFinite(endMs)) return [];
  const first = Math.floor((endMs - rangeHours * 60 * 60 * 1000) / bucketMs) * bucketMs;
  const last = Math.floor(endMs / bucketMs) * bucketMs;
  const keys: string[] = [];
  for (let timestamp = first; timestamp <= last; timestamp += bucketMs) keys.push(new Date(timestamp).toISOString());
  return keys;
}

function metricSamples(data: DashboardData, metric: MetricKey): Array<{ date: string; value: number }> {
  const bucketMs = range === '24h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const source = new Map<string, MetricTrendPoint>();
  for (const item of data.metricTrend ?? []) {
    const timestamp = new Date(item.date).getTime();
    if (Number.isFinite(timestamp)) source.set(new Date(Math.floor(timestamp / bucketMs) * bucketMs).toISOString(), item);
  }
  const samples = intervalKeys(data.updatedAt).map(date => {
    const item = source.get(date);
    const raw = metric === 'credits' ? item?.spend : item?.[metric];
    return { date, value: raw == null ? 0 : Number(raw) };
  });
  if (metric === 'credits') {
    let laterSpend = 0;
    for (let index = samples.length - 1; index >= 0; index--) {
      const sample = samples[index]!;
      sample.value = data.credits.remaining + laterSpend;
      laterSpend += source.get(sample.date)?.spend ?? 0;
    }
  }
  return samples;
}

function formatMetricValue(metric: MetricKey, value: number): string {
  if (metric === 'credits' || metric === 'spend') return money(value);
  if (metric === 'cacheHitRate') return percent(value);
  return compact(value);
}

function formatChartValue(metric: ChartMetric, value: number): string {
  return metric === 'spend' ? money(value) : compact(value);
}

function metricNumberMarkup(value: string): string {
  return [...value].map(character => `<span class="metric-glyph" aria-hidden="true">${escapeHtml(character)}</span>`).join('');
}

function rollingMetricMarkup(value: string, previous: string): string {
  const oldDigits = [...previous].filter(character => /\d/.test(character)).reverse();
  const characters = [...value];
  return characters.map((character, index) => {
    if (!/\d/.test(character)) return `<span class="metric-glyph" aria-hidden="true">${escapeHtml(character)}</span>`;
    const digitIndex = characters.slice(index + 1).filter(next => /\d/.test(next)).length;
    const oldDigit = oldDigits[digitIndex];
    if (oldDigit == null || oldDigit === character) return `<span class="metric-glyph" aria-hidden="true">${character}</span>`;
    return `<span class="metric-roll-cell" aria-hidden="true"><span class="metric-roll-track"><span>${oldDigit}</span><span>${character}</span></span></span>`;
  }).join('');
}

function formatInterval(dateValue: string): string {
  const date = new Date(dateValue);
  if (Number.isNaN(date.valueOf())) return dateValue;
  return date.toLocaleString('en-US', range === '24h'
    ? { month: 'short', day: 'numeric', hour: 'numeric' }
    : { month: 'short', day: 'numeric' });
}

function emptyState(message: string): string {
  return `<div class="empty-state"><span class="empty-mark">${icon('activity', 20)}</span><p>${message}</p></div>`;
}

function sparklinePoint(samples: Array<{ date: string; value: number }>, index: number): { x: number; y: number } {
  const width = 112;
  const height = 34;
  const pad = 3;
  const values = samples.map(sample => sample.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const sample = samples[index];
  if (!sample) return { x: width / 2, y: height / 2 };
  const x = samples.length < 2 ? width / 2 : pad + index / (samples.length - 1) * (width - pad * 2);
  const y = max === min ? height / 2 : height - pad - (sample.value - min) / (max - min) * (height - pad * 2);
  return { x, y };
}

function sparkline(samples: Array<{ date: string; value: number }>, color: string, metric: MetricKey): string {
  const width = 112;
  const height = 34;
  const pad = 3;
  const points = samples.map((_, index) => sparklinePoint(samples, index));
  const line = points.length ? points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ') : `M${pad} ${height / 2}H${width - pad}`;
  const area = points.length > 1 ? `${line} L${points.at(-1)!.x.toFixed(1)} ${height} L${points[0]!.x.toFixed(1)} ${height} Z` : '';
  const last = points.at(-1) ?? { x: width / 2, y: height / 2 };
  return `<svg class="metric-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" data-metric-sparkline="${metric}" role="img" aria-label="${metric} trend, hover to inspect intervals"><path d="${area}" fill="${color}" opacity=".09"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle class="sparkline-marker" cx="${last.x}" cy="${last.y}" r="2.5" fill="${color}" opacity="0"/></svg>`;
}

function metricCard(title: string, value: string, name: keyof typeof icons, color: string, metric: MetricKey, data: DashboardData | null): string {
  const samples = data && metric !== 'credits' ? metricSamples(data, metric) : [];
  const defaultSamples = samples.length ? samples : [{ date: '', value: 0 }, { date: '', value: 0 }];
  const graph = metric === 'credits'
    ? '<span class="metric-sparkline-spacer" aria-hidden="true"></span>'
    : sparkline(defaultSamples, data ? color : '#4a5155', metric);
  return `<article class="metric-card" data-metric-label="${escapeHtml(title)}">
    <div class="metric-top"><span class="metric-label"><span class="metric-icon" style="--metric-color:${color}">${icon(name, 15)}</span>${title}</span>${graph}</div>
    <div class="metric-value-row"><div class="metric-value" aria-label="${escapeHtml(value)}" data-metric-value="${metric}" data-default-value="${escapeHtml(value)}">${metricNumberMarkup(value)}</div></div>
  </article>`;
}

function usageTrendChart(data: DashboardData): string {
  if (!data.capabilities.modelDimension) return emptyState('Model-level usage isn’t available in the analytics response.');
  const points = data.trend;
  const bucketMs = range === '24h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const buckets = new Map<string, Map<string, number>>();
  const modelTotals = new Map<string, number>();

  for (const date of intervalKeys(data.updatedAt)) buckets.set(date, new Map<string, number>());
  for (const point of points) {
    const timestamp = new Date(point.date).getTime();
    if (!Number.isFinite(timestamp)) continue;
    const dateKey = new Date(Math.floor(timestamp / bucketMs) * bucketMs).toISOString();
    const bucket = buckets.get(dateKey) ?? new Map<string, number>();
    const value = Number(point[chartMetric] ?? 0);
    bucket.set(point.model, (bucket.get(point.model) ?? 0) + value);
    buckets.set(dateKey, bucket);
    modelTotals.set(point.model, (modelTotals.get(point.model) ?? 0) + value);
  }

  const dates = [...buckets.keys()].sort();
  const models = [...modelTotals.keys()].sort((a, b) => modelTotals.get(b)! - modelTotals.get(a)!);
  const colors = ['#ff684c', '#4c8dff', '#a46aff', '#f5b942', '#42c4a6', '#ed5caa', '#7c8994'];
  const colorFor = new Map(models.map((model, index) => [model, colors[index % colors.length]!]));
  const totals = dates.map(date => [...buckets.get(date)!.values()].reduce((sum, value) => sum + value, 0));
  const max = Math.max(...totals, 1);
  const width = 960;
  const height = 260;
  const slotWidth = width / dates.length;
  const gap = Math.min(10, Math.max(3, slotWidth * .2));
  const barWidth = Math.max(1, slotWidth - gap);
  const grid = [0, 0.25, 0.5, 0.75, 1].map(fraction => {
    const y = height * (1 - fraction);
    return `<path d="M0 ${y.toFixed(1)}H${width}" stroke="#252a2d" stroke-width="1" ${fraction ? 'stroke-dasharray="3 5"' : ''}/>`;
  }).join('');

  const columns = dates.map((date, index) => {
    const slotX = index * slotWidth;
    const x = slotX + (slotWidth - barWidth) / 2;
    const bucket = buckets.get(date)!;
    let y = height;
    const segments = models.map(model => {
      const value = bucket.get(model) ?? 0;
      if (value <= 0) return '';
      const segmentHeight = value / max * height;
      y -= segmentHeight;
       return `<rect data-bucket-key="${escapeHtml(date)}" data-model="${escapeHtml(model)}" data-model-value="${value}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${segmentHeight.toFixed(1)}" fill="${colorFor.get(model)}" stroke="#0c0f11" stroke-width=".8"/>`;
    }).join('');
    return `<g data-bucket-group="${escapeHtml(date)}"><rect class="chart-column-highlight" x="${slotX.toFixed(1)}" y="0" width="${slotWidth.toFixed(1)}" height="${height}"/><rect data-bucket-key="${escapeHtml(date)}" x="${slotX.toFixed(1)}" y="0" width="${slotWidth.toFixed(1)}" height="${height}" fill="transparent" pointer-events="all"/>${segments}</g>`;
  }).join('');

  const labelCount = Math.min(7, dates.length);
  const labelIndexes = [...new Set(Array.from({ length: labelCount }, (_, index) =>
    Math.round(index * (dates.length - 1) / Math.max(1, labelCount - 1))))];
  const labels = labelIndexes.map(index => {
    const date = new Date(dates[index]!);
    const label = date.toLocaleString('en-US', range === '24h'
      ? { month: 'short', day: 'numeric', hour: 'numeric' }
      : { month: 'short', day: 'numeric' });
    return `<span>${escapeHtml(label)}</span>`;
  }).join('');
  const legend = models.map(model => `<span class="chart-legend-item"><i style="background:${colorFor.get(model)}"></i>${escapeHtml(model)}</span>`).join('');

  return `<div class="chart-wrap"><div class="chart-y-labels"><span>${formatChartValue(chartMetric, max)}</span><span>${formatChartValue(chartMetric, max * .75)}</span><span>${formatChartValue(chartMetric, max * .5)}</span><span>${formatChartValue(chartMetric, max * .25)}</span><span>${chartMetric === 'spend' ? '$0' : '0'}</span></div><div class="spend-chart-stage"><svg class="spend-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Stacked ${chartMetric} by model during ${labelForRange(range)}">${grid}${columns}</svg><div class="chart-tooltip" role="tooltip" hidden></div></div><div class="chart-x-labels" style="grid-template-columns:repeat(${labelIndexes.length},minmax(0,1fr))">${labels}</div><div class="sr-only">Stacked by model: ${models.map(escapeHtml).join(', ')}</div></div><div class="panel-foot"><div class="chart-legend">${legend}</div><span class="panel-foot-range">${labelForRange(range)}</span></div>`;
}

function tokenBreakdown(data: DashboardData): string {
  const values = [
    { label: 'Prompt', value: data.breakdown.prompt, color: '#4c8dff' },
    { label: 'Completion', value: data.breakdown.completion, color: '#a46aff' },
    { label: 'Reasoning', value: data.breakdown.reasoning, color: '#ff5577' },
  ];
  const total = values.reduce((sum, item) => sum + (item.value ?? 0), 0);
  if (total === 0 && values.every(item => item.value == null)) return emptyState('Token breakdown isn’t available for this account or date range.');
  const segments = values.map(item => `<span style="width:${total ? (Number(item.value ?? 0) / total) * 100 : 0}%;background:${item.color}" title="${item.label}: ${compact(item.value)}"></span>`).join('');
  return `<div class="token-bar" role="img" aria-label="Token breakdown">${segments}</div><div class="token-legend">${values.map(item => `<div class="token-legend-item"><span class="legend-dot" style="background:${item.color}"></span><span>${item.label}</span><strong>${compact(item.value)}</strong></div>`).join('')}</div><div class="token-total"><span>Total measured</span><strong>${compact(total)}</strong></div>`;
}

function keyList(data: DashboardData): string {
  if (!data.capabilities.keyDimension) return emptyState('API key usage isn’t available in the analytics API response.');
  if (!data.keys.length) return emptyState('No API key usage in this date range.');
  const max = Math.max(...data.keys.map(item => item.tokens), 1);
  return `<div class="rank-list">${data.keys.slice(0, 5).map((item, index) => `<div class="rank-row"><span class="rank-number">${String(index + 1).padStart(2, '0')}</span><div class="rank-main"><div class="rank-title"><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><strong>${compact(item.tokens)} <small>tok</small></strong></div><div class="rank-track"><span style="width:${Math.max(2, item.tokens / max * 100)}%"></span></div></div></div>`).join('')}</div>`;
}

function modelList(data: DashboardData): string {
  if (!data.capabilities.modelDimension) return emptyState('Model-level usage isn’t available in the analytics response.');
  if (!data.models.length) return emptyState('No model usage in this date range.');
  const max = Math.max(...data.models.map(item => item.spend), 0.0001);
  return `<div class="model-list">${data.models.slice(0, 6).map(item => `<div class="model-row"><div class="model-row-head"><div class="model-name"><span class="model-orb">✳</span><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span></div><div class="model-amount">${money(item.spend)}</div></div><div class="model-row-sub"><span>${compact(item.tokens)} tokens</span><span>${item.spend ? `${(item.spend / Math.max(data.metrics.spend ?? item.spend, 0.0001) * 100).toFixed(0)}% of spend` : '—'}</span></div><div class="model-track"><span style="width:${Math.max(item.spend ? 2 : 0, item.spend / max * 100)}%"></span></div></div>`).join('')}</div>`;
}

function appTemplate(): string {
  const data = latest;
  const metrics = data?.metrics;
  const setupError = errorMessage.includes('Add your');
  return `<div class="app-shell">
    <main class="main-content" id="activity">
      <div class="content-wrap">
        <div class="page-heading"><div class="page-title"><h1>OpenRouter Usage</h1></div><div class="heading-controls"><span class="refresh-status"><span id="refresh-error" class="refresh-error" role="status" title="${escapeHtml(errorMessage)}" ${!errorMessage || setupError ? 'hidden' : ''}>${setupError ? '' : escapeHtml(errorMessage)}</span><span class="auto-refresh"><i></i><span id="refresh-countdown">${loading ? 'Refreshing…' : refreshCountdown()}</span></span></span><label class="range-select">${icon('calendar', 16)}<select id="range" aria-label="Date range"><option value="24h" ${range === '24h' ? 'selected' : ''}>Past 24 hours</option><option value="7d" ${range === '7d' ? 'selected' : ''}>Past 7 days</option><option value="30d" ${range === '30d' ? 'selected' : ''}>Past 30 days</option></select><span class="select-chevron">⌄</span></label><button id="refresh" class="icon-button" aria-label="Refresh dashboard" ${loading ? 'disabled' : ''}>${icon('refresh', 17)}</button></div></div>
        ${setupError ? `<section class="notice notice-setup" role="alert"><div class="notice-icon">!</div><div><strong>Connect your OpenRouter account</strong><p>${escapeHtml(errorMessage)}</p><p class="setup-hint">In <code>openrouter-dashboard/</code>, copy <code>.env.example</code> to <code>.env</code>, add a Management API key, then restart the app.</p></div><button id="retry" class="text-button">Retry</button></section>` : ''}
        <section class="metric-grid" id="overview" aria-label="Usage summary">
          ${metricCard('Available credits', money(data?.credits.remaining), 'coin', '#9b6cff', 'credits', data)}
          ${metricCard('Total spend', money(metrics?.spend), 'arrow', '#ff684c', 'spend', data)}
          ${metricCard('Requests', compact(metrics?.requests), 'requests', '#62c4a6', 'requests', data)}
          ${metricCard('Token volume', compact(metrics?.tokens), 'tokens', '#548dff', 'tokens', data)}
          ${metricCard('Cache hit rate', percent(metrics?.cacheHitRate), 'activity', '#f5b942', 'cacheHitRate', data)}
        </section>
        <section class="chart-panel panel">
          <div class="panel-heading"><div><h2>${chartMetric === 'spend' ? 'Spend over time' : 'Tokens over time'}</h2><p>${range === '24h' ? 'Hourly' : 'Daily'} usage · all models</p></div><div class="chart-tools"><div class="chart-switch" role="group" aria-label="Graph metric"><button type="button" data-chart-metric="spend" aria-pressed="${chartMetric === 'spend'}">Spend</button><button type="button" data-chart-metric="tokens" aria-pressed="${chartMetric === 'tokens'}">Tokens</button></div><div class="chart-total"><span>Range total</span><strong>${chartMetric === 'spend' ? money(metrics?.spend) : compact(metrics?.tokens)}</strong></div></div></div>
          ${data ? usageTrendChart(data) : emptyState(loading ? 'Loading activity…' : 'Connect to load your usage history.')}
        </section>
        <section class="usage-layout">
          <article class="panel usage-keys" id="keys"><div class="panel-heading"><div><h2>Top API keys</h2><p>Ranked by generated tokens</p></div><span class="heading-icon">${icon('key')}</span></div>${data ? keyList(data) : emptyState(loading ? 'Loading API key usage…' : 'Connect to load key usage.')}</article>
          <article class="panel usage-model"><div class="panel-heading"><div><h2>Usage by model</h2><p>Spend and token volume</p></div><span class="heading-icon">${icon('tokens')}</span></div>${data ? modelList(data) : emptyState(loading ? 'Loading model usage…' : 'Connect to load model usage.')}</article>
          <article class="panel usage-tokens"><div class="panel-heading"><div><h2>Token breakdown</h2><p>Prompt, completion, and reasoning</p></div><span class="heading-icon">${icon('tokens')}</span></div>${data ? tokenBreakdown(data) : emptyState('Connect to load token usage.')}</article>
        </section>
      </div>
    </main>
  </div>`;
}

function render(): void {
  const previousValues = new Map<string, string>();
  for (const element of root.querySelectorAll<HTMLElement>('[data-metric-value]')) {
    const key = element.dataset.metricValue;
    if (key) previousValues.set(key, element.dataset.defaultValue ?? element.textContent ?? '');
  }
  root.innerHTML = appTemplate();
  animateMetricValues(previousValues);
  attachSpendTooltip();
  attachMetricSparklines();
  root.querySelector<HTMLSelectElement>('#range')?.addEventListener('change', event => {
    range = (event.currentTarget as HTMLSelectElement).value as Range;
    void loadDashboard();
  });
  root.querySelector<HTMLButtonElement>('#refresh')?.addEventListener('click', () => void loadDashboard());
  root.querySelector<HTMLButtonElement>('#retry')?.addEventListener('click', () => void loadDashboard());
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-chart-metric]')) {
    button.addEventListener('click', () => {
      const next = button.dataset.chartMetric;
      if (next !== 'spend' && next !== 'tokens') return;
      chartMetric = next;
      render();
    });
  }
}

function animateMetricValues(previousValues: Map<string, string>): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-metric-value]')) {
    const key = element.dataset.metricValue;
    const previous = key ? previousValues.get(key) : undefined;
    const next = element.dataset.defaultValue;
    if (!previous || !next || previous === next || !/\d/.test(previous)) continue;
    element.setAttribute('aria-label', next);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      element.innerHTML = metricNumberMarkup(next);
      continue;
    }

    element.innerHTML = rollingMetricMarkup(next, previous);
    const track = element.querySelector<HTMLElement>('.metric-roll-track');
    track?.addEventListener('animationend', () => {
      element.innerHTML = metricNumberMarkup(next);
      element.setAttribute('aria-label', next);
    }, { once: true });
  }
}

function attachMetricSparklines(): void {
  if (!latest) return;
  for (const chart of root.querySelectorAll<SVGSVGElement>('[data-metric-sparkline]')) {
    const metric = chart.dataset.metricSparkline as MetricKey;
    const samples = metricSamples(latest, metric);
    const card = chart.closest<HTMLElement>('.metric-card');
    const value = card?.querySelector<HTMLElement>('[data-metric-value]');
    const marker = chart.querySelector<SVGCircleElement>('.sparkline-marker');
    if (!card || !value || !marker || !samples.length) continue;

    chart.addEventListener('pointermove', event => {
      const bounds = chart.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      const index = Math.round(fraction * (samples.length - 1));
      const sample = samples[index]!;
      const point = sparklinePoint(samples, index);
      const formattedValue = formatMetricValue(metric, sample.value);
      value.innerHTML = metricNumberMarkup(formattedValue);
      value.setAttribute('aria-label', formattedValue);
      card.setAttribute('aria-label', `${card.dataset.metricLabel}: ${formattedValue} for ${formatInterval(sample.date)}`);
      marker.setAttribute('cx', String(point.x));
      marker.setAttribute('cy', String(point.y));
      marker.setAttribute('opacity', '1');
    });
    chart.addEventListener('pointerleave', () => {
      value.innerHTML = metricNumberMarkup(value.dataset.defaultValue ?? '');
      value.setAttribute('aria-label', value.dataset.defaultValue ?? '');
      card.removeAttribute('aria-label');
      marker.setAttribute('opacity', '0');
    });
  }
}

function attachSpendTooltip(): void {
  const chart = root.querySelector<SVGSVGElement>('.spend-chart');
  const stage = root.querySelector<HTMLElement>('.spend-chart-stage');
  const tooltip = root.querySelector<HTMLElement>('.chart-tooltip');
  if (!chart || !stage || !tooltip || !latest) return;
  const bucketMs = range === '24h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  let activeGroup: SVGGElement | null = null;

  const clearActiveGroup = () => {
    activeGroup?.classList.remove('chart-column-active');
    activeGroup = null;
  };

  chart.addEventListener('pointermove', event => {
    if (!(event.target instanceof Element)) return;
    const column = event.target.closest<SVGRectElement>('[data-bucket-key]');
    const dateKey = column?.dataset.bucketKey;
    if (!dateKey) { tooltip.hidden = true; clearActiveGroup(); return; }
    const group = column.closest<SVGGElement>('[data-bucket-group]');
    if (group !== activeGroup) {
      clearActiveGroup();
      activeGroup = group;
      activeGroup?.classList.add('chart-column-active');
    }

    const byModel = new Map<string, number>();
    for (const point of latest!.trend) {
      const timestamp = new Date(point.date).getTime();
      if (Number.isFinite(timestamp) && new Date(Math.floor(timestamp / bucketMs) * bucketMs).toISOString() === dateKey) {
        byModel.set(point.model, (byModel.get(point.model) ?? 0) + Number(point[chartMetric] ?? 0));
      }
    }
    const entries = [...byModel.entries()].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, [, value]) => sum + value, 0);

    const date = new Date(dateKey);
    const dateLabel = Number.isNaN(date.valueOf()) ? dateKey : date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: range === '24h' ? 'numeric' : undefined });
    const modelTotals = new Map<string, number>();
    for (const point of latest!.trend) modelTotals.set(point.model, (modelTotals.get(point.model) ?? 0) + Number(point[chartMetric] ?? 0));
    const colors = ['#ff684c', '#4c8dff', '#a46aff', '#f5b942', '#42c4a6', '#ed5caa', '#7c8994'];
    const rankedModels = [...modelTotals.keys()].sort((a, b) => modelTotals.get(b)! - modelTotals.get(a)!);
    const colorFor = new Map(rankedModels.map((model, index) => [model, colors[index % colors.length]!]));

    const detailValue = (value: number) => chartMetric === 'spend' ? money(value) : `${compact(value)} tokens`;
    const details = entries.length
      ? entries.map(([model, value]) => `<div class="chart-tooltip-row"><span><i style="background:${colorFor.get(model)}"></i>${escapeHtml(model)}</span><strong>${detailValue(value)}</strong></div>`).join('')
      : `<div class="chart-tooltip-empty">No ${chartMetric} in this period</div>`;
    tooltip.innerHTML = `<div class="chart-tooltip-heading"><span>${escapeHtml(dateLabel)}</span><strong>${detailValue(total)}</strong></div><div class="chart-tooltip-models">${details}</div>`;
    tooltip.hidden = false;

    const bounds = stage.getBoundingClientRect();
    const groupBounds = group?.getBoundingClientRect();
    const barCenter = groupBounds
      ? groupBounds.left + groupBounds.width / 2 - bounds.left
      : event.clientX - bounds.left;
    const tooltipHalfWidth = tooltip.offsetWidth / 2;
    const minX = Math.min(tooltipHalfWidth + 8, bounds.width / 2);
    const maxX = Math.max(bounds.width - tooltipHalfWidth - 8, bounds.width / 2);
    tooltip.style.left = `${Math.min(Math.max(barCenter, minX), maxX)}px`;
  });
  chart.addEventListener('pointerleave', () => {
    tooltip.hidden = true;
    clearActiveGroup();
  });
}

function updateRefreshStatus(): void {
  const error = root.querySelector<HTMLElement>('#refresh-error');
  if (error) {
    error.hidden = !errorMessage || errorMessage.includes('Add your');
    error.textContent = error.hidden ? '' : errorMessage;
    error.title = errorMessage;
  }
  const countdown = root.querySelector<HTMLElement>('#refresh-countdown');
  if (countdown) countdown.textContent = loading ? 'Refreshing…' : refreshCountdown();
  const refresh = root.querySelector<HTMLButtonElement>('#refresh');
  if (refresh) refresh.disabled = loading;
}

async function loadDashboard(): Promise<void> {
  if (loading) return;
  const hadSetupError = errorMessage.includes('Add your');
  let refreshSucceeded = false;
  loading = true;
  errorMessage = '';
  if (latest && !hadSetupError) updateRefreshStatus();
  else render();
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}api/dashboard?range=${range}`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
    latest = payload as DashboardData;
    refreshSucceeded = true;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unexpected error while loading data.';
  } finally {
    loading = false;
    nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
    if (refreshSucceeded || !latest || errorMessage.includes('Add your')) render();
    else updateRefreshStatus();
  }
}

render();
void loadDashboard();
window.setInterval(() => {
  if (!loading && Date.now() >= nextRefreshAt) void loadDashboard();
  const countdown = root.querySelector<HTMLElement>('#refresh-countdown');
  if (countdown) countdown.textContent = loading ? 'Refreshing…' : refreshCountdown();
}, 1000);
