/**
 * Minimal in-process metrics registry with a Prometheus text exposition.
 *
 * Why not a metrics library / agent? The deployment is a small number of Node
 * instances behind one database, and the platform (Docker/systemd/Kubernetes)
 * already scrapes or ships stdout. A dependency-free registry keeps the
 * contract explicit and avoids adding infrastructure the platform does not
 * need. The registry is exposed at `GET /metrics` in Prometheus format and at
 * the admin JSON snapshot.
 *
 * Cardinality is the thing that kills metrics stores, so labels here are
 * deliberately bounded: HTTP metrics are keyed by method + route template +
 * status class, never by raw path or user id. The route template is only
 * recorded for paths the app itself matches; unrecognised paths collapse to a
 * single `<other>` label.
 */

export type MetricKind = 'counter' | 'histogram' | 'gauge';

interface CounterState {
  kind: 'counter';
  help: string;
  values: Map<string, number>;
  labelNames: string[];
}

interface GaugeState {
  kind: 'gauge';
  help: string;
  values: Map<string, number>;
  labelNames: string[];
}

interface HistogramState {
  kind: 'histogram';
  help: string;
  labelNames: string[];
  buckets: number[];
  /** Per label-set: cumulative bucket counts, running sum, and total count. */
  values: Map<string, { buckets: number[]; sum: number; count: number }>;
}

export const DEFAULT_LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

function labelKey(labelNames: string[], labels: Record<string, string | number>): string {
  return labelNames
    .map((name) => `${name}=${String(labels[name] ?? '')}`)
    .join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(metricName: string, labelNames: string[], key: string): string {
  if (labelNames.length === 0) return '';
  const pairs = key.split(',');
  const rendered = labelNames
    .map((name, i) => {
      const raw = pairs[i] ?? '';
      const value = raw.slice(raw.indexOf('=') + 1);
      return `${name}="${escapeLabel(value)}"`;
    })
    .join(',');
  return `{${rendered}}`;
}

export class MetricsRegistry {
  private counters = new Map<string, CounterState>();
  private gauges = new Map<string, GaugeState>();
  private histograms = new Map<string, HistogramState>();

  counter(name: string, help: string, labelNames: string[] = []): void {
    if (!this.counters.has(name)) {
      this.counters.set(name, { kind: 'counter', help, labelNames, values: new Map() });
    }
  }

  gauge(name: string, help: string, labelNames: string[] = []): void {
    if (!this.gauges.has(name)) {
      this.gauges.set(name, { kind: 'gauge', help, labelNames, values: new Map() });
    }
  }

  histogram(
    name: string,
    help: string,
    labelNames: string[] = [],
    buckets: number[] = DEFAULT_LATENCY_BUCKETS,
  ): void {
    if (!this.histograms.has(name)) {
      const sorted = [...buckets].sort((a, b) => a - b);
      this.histograms.set(name, {
        kind: 'histogram',
        help,
        labelNames,
        buckets: sorted,
        values: new Map(),
      });
    }
  }

  incCounter(name: string, labels: Record<string, string | number> = {}, by = 1): void {
    const metric = this.counters.get(name);
    if (!metric) return;
    const key = labelKey(metric.labelNames, labels);
    metric.values.set(key, (metric.values.get(key) ?? 0) + by);
  }

  setGauge(name: string, value: number, labels: Record<string, string | number> = {}): void {
    const metric = this.gauges.get(name);
    if (!metric) return;
    metric.values.set(labelKey(metric.labelNames, labels), value);
  }

  observeHistogram(name: string, value: number, labels: Record<string, string | number> = {}): void {
    const metric = this.histograms.get(name);
    if (!metric) return;
    const key = labelKey(metric.labelNames, labels);
    let entry = metric.values.get(key);
    if (!entry) {
      entry = { buckets: new Array(metric.buckets.length).fill(0), sum: 0, count: 0 };
      metric.values.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < metric.buckets.length; i++) {
      if (value <= metric.buckets[i]) entry.buckets[i] += 1;
    }
  }

  /** Counter total for a label set, or 0. Used by alert rules. */
  counterValue(name: string, labels: Record<string, string | number> = {}): number {
    const metric = this.counters.get(name);
    if (!metric) return 0;
    return metric.values.get(labelKey(metric.labelNames, labels)) ?? 0;
  }

  gaugeValue(name: string, labels: Record<string, string | number> = {}): number {
    const metric = this.gauges.get(name);
    if (!metric) return 0;
    return metric.values.get(labelKey(metric.labelNames, labels)) ?? 0;
  }

  /** Histogram quantile for a label set (Prometheus-style linear interpolation). */
  histogramQuantile(
    name: string,
    quantile: number,
    labels: Record<string, string | number> = {},
  ): number | null {
    const metric = this.histograms.get(name);
    if (!metric) return null;
    const entry = metric.values.get(labelKey(metric.labelNames, labels));
    if (!entry || entry.count === 0) return null;
    const rank = quantile * entry.count;
    let previousBucket = 0;
    let previousCount = 0;
    for (let i = 0; i < metric.buckets.length; i++) {
      const cumulative = entry.buckets[i];
      if (cumulative >= rank) {
        const bucketStart = i === 0 ? 0 : metric.buckets[i - 1];
        const countInBucket = cumulative - previousCount;
        if (countInBucket === 0) return metric.buckets[i];
        const fraction = (rank - previousCount) / countInBucket;
        return bucketStart + (metric.buckets[i] - bucketStart) * fraction;
      }
      previousBucket = metric.buckets[i];
      previousCount = cumulative;
    }
    return previousBucket;
  }

  private renderCounterOrGauge(
    name: string,
    kind: MetricKind,
    help: string,
    labelNames: string[],
    values: Map<string, number>,
    lines: string[],
  ): void {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${kind}`);
    if (values.size === 0) {
      lines.push(`${name} 0`);
      return;
    }
    for (const [key, value] of values) {
      lines.push(`${name}${formatLabels(name, labelNames, key)} ${value}`);
    }
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [name, metric] of this.counters) {
      this.renderCounterOrGauge(name, 'counter', metric.help, metric.labelNames, metric.values, lines);
    }
    for (const [name, metric] of this.gauges) {
      this.renderCounterOrGauge(name, 'gauge', metric.help, metric.labelNames, metric.values, lines);
    }
    for (const [name, metric] of this.histograms) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const [key, entry] of metric.values) {
        for (let i = 0; i < metric.buckets.length; i++) {
          const labels = labelNamesWith(metric.labelNames, key, { le: String(metric.buckets[i]) });
          lines.push(`${name}_bucket${labels} ${entry.buckets[i]}`);
        }
        const infLabels = labelNamesWith(metric.labelNames, key, { le: '+Inf' });
        lines.push(`${name}_bucket${infLabels} ${entry.count}`);
        const base = formatLabels(name, metric.labelNames, key);
        lines.push(`${name}_sum${base} ${entry.sum}`);
        lines.push(`${name}_count${base} ${entry.count}`);
      }
      if (metric.values.size === 0) {
        for (const bucket of metric.buckets) {
          lines.push(`${name}_bucket{le="${bucket}"} 0`);
        }
        lines.push(`${name}_bucket{le="+Inf"} 0`);
        lines.push(`${name}_sum 0`);
        lines.push(`${name}_count 0`);
      }
    }
    return lines.join('\n') + '\n';
  }

  /** Machine-readable snapshot for the admin endpoint (no Prometheus syntax). */
  snapshot(): {
    counters: Record<string, Array<{ labels: Record<string, string>; value: number }>>;
    gauges: Record<string, Array<{ labels: Record<string, string>; value: number }>>;
    histograms: Record<
      string,
      Array<{ labels: Record<string, string>; count: number; sum: number; quantiles: Record<string, number> }>
    >;
  } {
    const counters: Record<string, Array<{ labels: Record<string, string>; value: number }>> = {};
    for (const [name, metric] of this.counters) {
      counters[name] = [...metric.values].map(([key, value]) => ({
        labels: labelsToRecord(metric.labelNames, key),
        value,
      }));
    }
    const gauges: Record<string, Array<{ labels: Record<string, string>; value: number }>> = {};
    for (const [name, metric] of this.gauges) {
      gauges[name] = [...metric.values].map(([key, value]) => ({
        labels: labelsToRecord(metric.labelNames, key),
        value,
      }));
    }
    const histograms: Record<
      string,
      Array<{ labels: Record<string, string>; count: number; sum: number; quantiles: Record<string, number> }>
    > = {};
    for (const [name, metric] of this.histograms) {
      histograms[name] = [...metric.values].map(([key, entry]) => ({
        labels: labelsToRecord(metric.labelNames, key),
        count: entry.count,
        sum: entry.sum,
        quantiles: {
          p50: this.histogramQuantile(name, 0.5, labelsToRecord(metric.labelNames, key)) ?? 0,
          p95: this.histogramQuantile(name, 0.95, labelsToRecord(metric.labelNames, key)) ?? 0,
          p99: this.histogramQuantile(name, 0.99, labelsToRecord(metric.labelNames, key)) ?? 0,
        },
      }));
    }
    return { counters, gauges, histograms };
  }

  /** Test/restart helper. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

function labelsToRecord(labelNames: string[], key: string): Record<string, string> {
  const pairs = key.split(',');
  const record: Record<string, string> = {};
  labelNames.forEach((name, i) => {
    const raw = pairs[i] ?? '';
    record[name] = raw.slice(raw.indexOf('=') + 1);
  });
  return record;
}

function labelNamesWith(
  labelNames: string[],
  key: string,
  extra: Record<string, string>,
): string {
  const record = labelsToRecord(labelNames, key);
  const merged = { ...record, ...extra };
  const names = [...labelNames, ...Object.keys(extra)];
  const rendered = names.map((name) => `${name}="${escapeLabel(String(merged[name]))}"`).join(',');
  return `{${rendered}}`;
}

/** The process-wide registry, with the metrics WASIT actually emits. */
export const metrics = new MetricsRegistry();

function init(): void {
  metrics.counter('wasit_http_requests_total', 'HTTP requests handled', ['method', 'route', 'status']);
  metrics.histogram(
    'wasit_http_request_duration_seconds',
    'HTTP request duration in seconds',
    ['method', 'route'],
  );
  metrics.counter('wasit_http_errors_total', 'HTTP 5xx responses', ['route', 'status']);
  metrics.counter('wasit_rate_limit_rejections_total', 'Requests rejected by the rate limiter', ['prefix']);
  metrics.counter('wasit_audit_writes_total', 'Audit log rows written');
  metrics.counter('wasit_alerts_fired_total', 'Alert transitions to firing', ['rule']);
  metrics.counter('wasit_alert_notifications_total', 'Alert notifications delivered', ['channel', 'result']);
  metrics.gauge('wasit_db_up', 'Database reachable (1) or not (0)');
  metrics.gauge('wasit_uptime_seconds', 'Process uptime in seconds');
  metrics.gauge('wasit_build_info', 'Build information', ['version', 'env']);
}
init();

export function resetMetrics(): void {
  metrics.reset();
  init();
}