import { createClient } from '@supabase/supabase-js';
import { unstable_cache } from 'next/cache';
import type { FetchResult, IdxChartPoint, Rates } from './fx';

type SnapshotRow = {
  bucket_ts: string;
  idx: number;
  rates: Rates;
  assets: FetchResult['assets'] | null;
  provider: string;
};

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !publishableKey) return null;

  return createClient(url, publishableKey);
}

function rowToFetchResult(row: SnapshotRow): FetchResult {
  return {
    rates: row.rates,
    assets: row.assets ?? [],
    provider: row.provider,
    updatedAt: row.bucket_ts,
  };
}

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
        isSynthetic: false,
      });
    } else {
      lastPoint.idx = Number(latestRow.idx);
      lastPoint.isSynthetic = false;
    }
  }

  return normalizeSyntheticChartPoints(points);
}

async function readStoredDashboardData() {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data: latestRows, error: latestError } = await supabase
    .from('idrxy_snapshots')
    .select('bucket_ts, idx, rates, assets, provider')
    .order('bucket_ts', { ascending: false })
    .limit(1);

  if (latestError || !latestRows?.length) return null;

  const latest = latestRows[0] as SnapshotRow;
  const latestDate = new Date(latest.bucket_ts);
  let previousWeekdayStart = previousJakartaWeekdayStartUtc(latestDate);
  let yesterday: SnapshotRow | null = null;

  for (let attempt = 0; attempt < 10 && !yesterday; attempt++) {
    const { data: previousRows } = await supabase
      .from('idrxy_snapshots')
      .select('bucket_ts, idx, rates, assets, provider')
      .gte('bucket_ts', previousWeekdayStart.toISOString())
      .lte('bucket_ts', jakartaDayEndUtc(previousWeekdayStart).toISOString())
      .order('bucket_ts', { ascending: false })
      .limit(1);

    yesterday = ((previousRows ?? [])[0] as SnapshotRow | undefined) ?? null;
    previousWeekdayStart = previousJakartaWeekdayStartUtc(previousWeekdayStart);
  }

  const chartMin = new Date(jakartaDayStartUtc(latestDate));
  chartMin.setUTCDate(chartMin.getUTCDate() - 10);

  const allRows: SnapshotRow[] = [];
  let currentStart = chartMin.toISOString();

  while (true) {
    const { data: chunk, error } = await supabase
      .from('idrxy_snapshots')
      .select('bucket_ts, idx')
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
    yesterday: yesterday ? rowToFetchResult(yesterday) : null,
    chartPoints: points,
  };
}

export const getStoredDashboardData = unstable_cache(
  readStoredDashboardData,
  ['idrxy-dashboard-snapshots'],
  { revalidate: 60 },
);
