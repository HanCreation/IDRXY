import { unstable_cache } from 'next/cache';
import { getSupabaseClient } from './lib/supabase';

export type BondYields = Record<string, number>;

type BondSnapshotRow = {
  country_code: string;
  country_name: string;
  observation_date: string;
  source: string;
  yields: BondYields | null;
  fetched_at: string;
};

export type BondMarketRow = {
  countryCode: 'US' | 'ID' | string;
  countryName: string;
  observationDate: string;
  fetchedAt: string;
  source: string;
  yields: BondYields;
  previousYields?: BondYields | null;
  previousObservationDate?: string | null;
};

function normalizeRow(row: BondSnapshotRow, previous?: BondSnapshotRow | null): BondMarketRow {
  return {
    countryCode: row.country_code,
    countryName: row.country_name,
    observationDate: row.observation_date,
    fetchedAt: row.fetched_at,
    source: row.source,
    yields: row.yields ?? {},
    previousYields: previous?.yields ?? null,
    previousObservationDate: previous?.observation_date ?? null,
  };
}

async function readLatestCountryBond(supabase: ReturnType<typeof getSupabaseClient>, countryCode: 'US' | 'ID') {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('bond_yield_snapshots')
    .select('country_code, country_name, observation_date, source, yields, fetched_at')
    .eq('country_code', countryCode)
    .order('observation_date', { ascending: false })
    .order('fetched_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error(`Failed to read ${countryCode} bond yield snapshots:`, error.message);
    return null;
  }

  const latest = (data?.[0] ?? null) as BondSnapshotRow | null;
  if (!latest) return null;

  // The second most recently fetched row can still belong to the same market day.
  // Compare with the last *distinct observation date* instead.
  const { data: previousRows, error: previousError } = await supabase
    .from('bond_yield_snapshots')
    .select('country_code, country_name, observation_date, source, yields, fetched_at')
    .eq('country_code', countryCode)
    .lt('observation_date', latest.observation_date)
    .order('observation_date', { ascending: false })
    .order('fetched_at', { ascending: false })
    .limit(1);

  if (previousError) {
    console.error(`Failed to read previous ${countryCode} bond yields:`, previousError.message);
  }

  const previous = (previousRows?.[0] ?? null) as BondSnapshotRow | null;
  return normalizeRow(latest, previous);
}
async function readBondMarketData(): Promise<BondMarketRow[]> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn('Supabase env vars are missing; bond market data unavailable.');
    return [];
  }

  const rows = await Promise.all([
    readLatestCountryBond(supabase, 'US'),
    readLatestCountryBond(supabase, 'ID'),
  ]);

  return rows.filter((row): row is BondMarketRow => Boolean(row));
}

export const getBondMarketData = unstable_cache(
  readBondMarketData,
  ['idrxy-bond-market'],
  { revalidate: 300 },
);
