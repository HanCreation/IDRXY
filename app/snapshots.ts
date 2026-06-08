import { unstable_cache } from 'next/cache';
import { getSupabaseClient } from './lib/supabase';
import type { FetchResult, IdxChartPoint, Rates } from './fx';

type SnapshotRow = {
  bucket_ts: string;
  idx: number;
  rates: Rates;
  assets: FetchResult['assets'] | null;
  provider: string;
  created_at?: string | null;
};

function rowToFetchResult(row: SnapshotRow): FetchResult {
  return {
    rates: row.rates,
    assets: row.assets ?? [],
    provider: row.provider,
    updatedAt: row.bucket_ts,
  };
}

export type StoredDashboardData = {
  current: FetchResult | null;
  previous: FetchResult | null;
  comparison: {
    label: string;
    timestamp: string;
  } | null;
  chartPoints: IdxChartPoint[];
};

function nearestSnapshot(rows: SnapshotRow[], target: Date) {
  if (!rows.length) return null;

  return rows
    .map((row) => ({
      row,
      diff: Math.abs(new Date(row.bucket_ts).getTime() - target.getTime()),
    }))
    .sort((a, b) => a.diff - b.diff)[0].row;
}

function jakartaDayStartUtc(date: Date) {
  const jakartaOffsetMs = 7 * 60 * 60 * 1000;
  const jakartaDate = new Date(date.getTime() + jakartaOffsetMs);
  return new Date(Date.UTC(
    jakartaDate.getUTCFullYear(),
    jakartaDate.getUTCMonth(),
    jakartaDate.getUTCDate(),
    -7,
    0,
    0,
    0,
  ));
}

function isJakartaWeekday(date: Date) {
  const jakartaOffsetMs = 7 * 60 * 60 * 1000;
  const jakartaDate = new Date(date.getTime() + jakartaOffsetMs);
  const day = jakartaDate.getUTCDay();

  return day !== 0 && day !== 6;
}

function utcDayStart(date: Date) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
    0,
  ));
}

function isUtcWeekday(date: Date) {
  const day = date.getUTCDay();

  return day !== 0 && day !== 6;
}

function previousJakartaWeekdayStartUtc(date: Date) {
  const day = jakartaDayStartUtc(date);

  do {
    day.setUTCDate(day.getUTCDate() - 1);
  } while (!isJakartaWeekday(day));

  return day;
}

function jakartaDayEndUtc(dayStart: Date) {
  return new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
}

function normalizeSyntheticChartPoints(points: IdxChartPoint[]) {
  const realValues = points
    .filter((point) => !point.isSynthetic && Number.isFinite(point.idx))
    .map((point) => point.idx);
  const weeklyLow = realValues.length ? Math.min(...realValues) : 0;

  return points.map((point, index) => {
    if (!point.isSynthetic) return point;

    const previousRealIndex = points
      .slice(0, index)
      .findLastIndex((candidate) => !candidate.isSynthetic);
    const nextRealOffset = points
      .slice(index + 1)
      .findIndex((candidate) => !candidate.isSynthetic);
    const nextRealIndex = nextRealOffset === -1 ? -1 : index + 1 + nextRealOffset;
    const previousReal = previousRealIndex === -1 ? null : points[previousRealIndex];
    const nextReal = nextRealIndex === -1 ? null : points[nextRealIndex];

    if (previousReal && nextReal) {
      const progress = (index - previousRealIndex) / (nextRealIndex - previousRealIndex);

      return {
        ...point,
        idx: previousReal.idx + (nextReal.idx - previousReal.idx) * progress,
      };
    }

    return {
      ...point,
      idx: weeklyLow,
    };
  });
}

function buildChartPoints(rows: SnapshotRow[], latestDate: Date): IdxChartPoint[] {
  const points: IdxChartPoint[] = [];
  const slotHours = [0, 2, 5, 8, 13, 17];
  const slotToleranceMs = 10 * 60 * 1000;
  const latestDayStart = utcDayStart(latestDate);
  const weekdayRows = rows.filter((row) => isUtcWeekday(new Date(row.bucket_ts)));
  const latestRow = weekdayRows[weekdayRows.length - 1] ?? null;
  let lastIdx = 0;
  const days: Date[] = [];

  for (let dayOffset = 14; dayOffset >= 0; dayOffset--) {
    const day = new Date(latestDayStart);
    day.setUTCDate(day.getUTCDate() - dayOffset);
    if (isUtcWeekday(day)) days.push(day);
  }

  for (const day of days.slice(-7)) {
    for (const hour of slotHours) {
      const target = new Date(day);
      target.setUTCHours(hour, 0, 0, 0);
      if (target.getTime() > latestDate.getTime()) continue;

      const nearest = nearestSnapshot(weekdayRows, target);
      const diff = nearest
        ? Math.abs(new Date(nearest.bucket_ts).getTime() - target.getTime())
        : Number.POSITIVE_INFINITY;

      const hasRealPoint = Boolean(nearest && diff <= slotToleranceMs);

      if (hasRealPoint && nearest) {
        lastIdx = Number(nearest.idx);
      }

      points.push({
        timestamp: hasRealPoint && nearest
          ? new Date(nearest.bucket_ts).toISOString()
          : target.toISOString(),
        idx: lastIdx,
        rates: hasRealPoint && nearest ? nearest.rates : undefined,
        isSynthetic: !hasRealPoint,
      });
    }
  }

  if (latestRow) {
    const latestTimestamp = new Date(latestRow.bucket_ts).toISOString();
    const lastPoint = points[points.length - 1];

    if (!lastPoint || lastPoint.timestamp !== latestTimestamp) {
      points.push({
        timestamp: latestTimestamp,
        idx: Number(latestRow.idx),
        rates: latestRow.rates,
        isSynthetic: false,
      });
    } else {
      lastPoint.idx = Number(latestRow.idx);
      lastPoint.rates = latestRow.rates;
      lastPoint.isSynthetic = false;
    }
  }

  return normalizeSyntheticChartPoints(points);
}

async function readStoredDashboardData() {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn('Supabase env vars are missing; dashboard data unavailable.');
    return {
      current: null,
      previous: null,
      comparison: null,
      chartPoints: [],
    } satisfies StoredDashboardData;
  }

  const { data: latestRows, error: latestError } = await supabase
    .from('idrxy_snapshots')
    .select('bucket_ts, idx, rates, assets, provider, created_at')
    .order('bucket_ts', { ascending: false })
    .limit(1);

  if (latestError) {
    console.error('Failed to read latest IDRXY snapshot:', latestError.message);
    return {
      current: null,
      previous: null,
      comparison: null,
      chartPoints: [],
    } satisfies StoredDashboardData;
  }

  if (!latestRows?.length) {
    return {
      current: null,
      previous: null,
      comparison: null,
      chartPoints: [],
    } satisfies StoredDashboardData;
  }

  const latest = latestRows[0] as SnapshotRow;
  const latestDate = new Date(latest.bucket_ts);
  const comparisonTarget = new Date(latestDate.getTime() - 24 * 60 * 60 * 1000);
  const comparisonToleranceMs = 15 * 60 * 1000;
  const comparisonStart = new Date(comparisonTarget.getTime() - comparisonToleranceMs);
  const comparisonEnd = new Date(comparisonTarget.getTime() + comparisonToleranceMs);

  const { data: comparisonRows, error: comparisonError } = await supabase
    .from('idrxy_snapshots')
    .select('bucket_ts, idx, rates, assets, provider, created_at')
    .gte('bucket_ts', comparisonStart.toISOString())
    .lte('bucket_ts', comparisonEnd.toISOString())
    .order('bucket_ts', { ascending: true });

  if (comparisonError) {
    console.error('Failed to read 24h comparison IDRXY snapshot:', comparisonError.message);
  }

  const previous = nearestSnapshot((comparisonRows ?? []) as SnapshotRow[], comparisonTarget);

  const chartMin = new Date(jakartaDayStartUtc(latestDate));
  chartMin.setUTCDate(chartMin.getUTCDate() - 10);

  const allRows: SnapshotRow[] = [];
  let currentStart = chartMin.toISOString();

  while (true) {
    const { data: chunk, error } = await supabase
      .from('idrxy_snapshots')
      .select('bucket_ts, idx, rates')
      .gte('bucket_ts', currentStart)
      .lte('bucket_ts', latestDate.toISOString())
      .order('bucket_ts', { ascending: true })
      .limit(1000);

    if (error || !chunk || chunk.length === 0) {
      break;
    }

    allRows.push(...(chunk as SnapshotRow[]));

    if (chunk.length < 1000) {
      break;
    }

    // Advance the start time to 1ms after the last row in this chunk
    const lastTimestamp = new Date(chunk[chunk.length - 1].bucket_ts);
    lastTimestamp.setUTCMilliseconds(lastTimestamp.getUTCMilliseconds() + 1);
    currentStart = lastTimestamp.toISOString();
  }

  const points = buildChartPoints(allRows, latestDate);

  return {
    current: rowToFetchResult(latest),
    previous: previous ? rowToFetchResult(previous) : null,
    comparison: previous ? {
      label: 'nearest 24h snapshot',
      timestamp: new Date(previous.bucket_ts).toISOString(),
    } : null,
    chartPoints: points,
  } satisfies StoredDashboardData;
}

export const getStoredDashboardData = unstable_cache(
  readStoredDashboardData,
  ['idrxy-dashboard-snapshots'],
  { revalidate: 60 },
);
