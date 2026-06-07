export type Pair = {
  code: string;
  name: string;
  flag: string;
  weight?: number;
};

export type Rates = Record<string, number>;

export type FetchResult = {
  rates: Rates;
  assets: AssetPrice[];
  provider: string;
  updatedAt: string;
  sourceDate?: string;
};

export type DashboardData = {
  current: FetchResult | null;
  yesterday?: FetchResult | null;
  chartPoints?: IdxChartPoint[];
  error?: string;
};

export type IdxChartPoint = {
  timestamp: string;
  idx: number;
  rates?: Rates;
  isSynthetic?: boolean;
};

export type AssetPrice = {
  asset: 'USDT' | 'XAUT' | 'XAU';
  name: string;
  idrPerTroyOunce?: number;
  idrPerGram?: number;
  idrRate: number;
  apiDate: string;
  provider: string;
};

export const BASELINE_DATE = '2000-01-01';
export const BASELINE_SOURCE_DATE = '2000-01-03';

export const PAIRS: Pair[] = [
  { code: 'USD', name: 'US Dollar', flag: '🇺🇸', weight: 0.25 },
  { code: 'SGD', name: 'Singapore Dollar', flag: '🇸🇬', weight: 0.18 },
  { code: 'EUR', name: 'Euro', flag: '🇪🇺', weight: 0.15 },
  { code: 'JPY', name: 'Japanese Yen', flag: '🇯🇵', weight: 0.12 },
  { code: 'GBP', name: 'British Pound', flag: '🇬🇧', weight: 0.08 },
  { code: 'AUD', name: 'Aus Dollar', flag: '🇦🇺', weight: 0.07 },
  { code: 'CNY', name: 'Chinese Yuan', flag: '🇨🇳', weight: 0.08 },
  { code: 'KRW', name: 'Korean Won', flag: '🇰🇷', weight: 0.04 },
  { code: 'MYR', name: 'Malaysian Ringgit', flag: '🇲🇾', weight: 0.03 },
];

export const ADDITIONAL_PAIRS: Pair[] = [
  { code: 'THB', name: 'Thai Baht', flag: '🇹🇭' },
  { code: 'PHP', name: 'Philippine Peso', flag: '🇵🇭' },
  { code: 'VND', name: 'Vietnamese Dong', flag: '🇻🇳' },
  { code: 'CHF', name: 'Swiss Franc', flag: '🇨🇭' },
  { code: 'SAR', name: 'Saudi Riyal', flag: '🇸🇦' },
  { code: 'TWD', name: 'Taiwan Dollar', flag: '🇹🇼' },
  { code: 'CAD', name: 'Canadian Dollar', flag: '🇨🇦' },
  { code: 'AED', name: 'UAE Dirham', flag: '🇦🇪' },
  { code: 'INR', name: 'Indian Rupee', flag: '🇮🇳' },
  { code: 'HKD', name: 'Hong Kong Dollar', flag: '🇭🇰' },
  { code: 'NZD', name: 'New Zealand Dollar', flag: '🇳🇿' },
  { code: 'TRY', name: 'Turkish Lira', flag: '🇹🇷' },
];

export const ALL_PAIRS = [...PAIRS, ...ADDITIONAL_PAIRS];

const ASSETS = [
  { code: 'usdt', asset: 'USDT' as const, name: 'Tether USD' },
  { code: 'xau', asset: 'XAU' as const, name: 'Gold Spot' },
  { code: 'xaut', asset: 'XAUT' as const, name: 'Tether Gold' },
];

const TROY_OUNCE_GRAMS = 31.1034768;

const COINBASE_EXCHANGE_RATES_API = 'https://api.coinbase.com/v2/exchange-rates';
const FAWAZ_PRIMARY_CDN = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies';
const FAWAZ_FALLBACK_CDN = 'https://latest.currency-api.pages.dev/v1/currencies';
const FX_TIMEOUT_MS = 6000;

// Baseline date: 03-01-2000 = 3 January 2000
export const BASELINE_RATES_2000: Rates = {
  AUD: 4484.14, 
  CNY: 839.3923, // Derived: DJP USD rate 6950 / FRED DEXCHUS 8.2798 CNY per USD = 839.3923 
  EUR: 6979.89, 
  GBP: 11219.39, // Direct DJP/Kemenkeu: 1 GBP = Rp 11,219.39;
  JPY: 67.8247, // Direct DJP/Kemenkeu gives 100 JPY = Rp 6,782.47,
  KRW: 6.1613, // Derived: DJP USD rate 6950 / FRED DEXKOUS 1128.00 KRW per USD = 6.1613 IDR/KRW;
  MYR: 1828.95, 
  SGD: 4165.92, 
  USD: 6950.00,
};

type FawazCurrencyResponse = {
  date?: unknown;
  [currency: string]: unknown;
};

type CoinbaseExchangeRatesResponse = {
  data?: {
    currency?: unknown;
    rates?: Record<string, unknown>;
  };
};

async function fetchJsonWithTimeout(url: string, timeoutMs = FX_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCoinbaseRates(currency: string) {
  const code = currency.toUpperCase();
  const url = `${COINBASE_EXCHANGE_RATES_API}?currency=${encodeURIComponent(code)}`;
  const data = await fetchJsonWithTimeout(url) as CoinbaseExchangeRatesResponse;

  if (!data.data || data.data.currency !== code || !data.data.rates || typeof data.data.rates !== 'object') {
    throw new Error(`Coinbase response missing "${code}" rates`);
  }

  return data.data.rates;
}

function readCoinbaseRate(rates: Record<string, unknown>, currency: string) {
  const rawValue = rates[currency.toUpperCase()];
  const value = typeof rawValue === 'string' ? Number(rawValue) : rawValue;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Coinbase response missing "${currency.toUpperCase()}" rate`);
  }

  return value;
}

async function fetchCurrencyFile(currency: string, minified = true) {
  const code = currency.toLowerCase();
  const path = `${code}${minified ? '.min' : ''}.json`;
  const primaryUrl = `${FAWAZ_PRIMARY_CDN}/${path}`;
  const fallbackUrl = `${FAWAZ_FALLBACK_CDN}/${path}`;

  try {
    return {
      data: await fetchJsonWithTimeout(primaryUrl) as FawazCurrencyResponse,
      provider: 'FAWAZ CDN · JSDELIVR',
    };
  } catch (primaryError) {
    try {
      return {
        data: await fetchJsonWithTimeout(fallbackUrl) as FawazCurrencyResponse,
        provider: 'FAWAZ CDN · PAGES.DEV',
      };
    } catch (fallbackError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Fawaz Currency API failed for ${code}: primary ${primaryMessage}; fallback ${fallbackMessage}`);
    }
  }
}

function readCurrencyMap(data: FawazCurrencyResponse, baseCurrency: string) {
  const code = baseCurrency.toLowerCase();
  const rates = data[code];
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
    throw new Error(`Fawaz response missing "${code}" currency map`);
  }

  return rates as Record<string, unknown>;
}

function readApiDate(data: FawazCurrencyResponse) {
  if (typeof data.date !== 'string' || !data.date) {
    throw new Error('Fawaz response missing API date');
  }

  return data.date;
}

export async function fetchCurrencyToIdr(currency: string) {
  const code = currency.toLowerCase();
  if (code === 'idr') {
    return { code: 'IDR', rateToIDR: 1, apiDate: '', provider: 'LOCAL' };
  }

  try {
    const coinbaseRates = await fetchCoinbaseRates(code);
    return {
      code: code.toUpperCase(),
      rateToIDR: readCoinbaseRate(coinbaseRates, 'IDR'),
      apiDate: '',
      provider: 'COINBASE',
    };
  } catch {
    const { data, provider } = await fetchCurrencyFile(code);
    const currencyMap = readCurrencyMap(data, code);
    const idrValue = currencyMap.idr;
    if (typeof idrValue !== 'number' || idrValue <= 0) {
      throw new Error(`Fawaz response missing "${code}.idr" rate`);
    }

    return {
      code: code.toUpperCase(),
      rateToIDR: idrValue,
      apiDate: readApiDate(data),
      provider,
    };
  }
}

async function fetchAssetToIdr(assetCode: string): Promise<AssetPrice> {
  const code = assetCode.toLowerCase();
  const assetConfig = ASSETS.find((asset) => asset.code === code);
  if (!assetConfig) throw new Error(`Unsupported asset "${assetCode}"`);

  if (code === 'usdt') {
    try {
      const idrRates = await fetchCoinbaseRates('IDR');
      const usdtPerIdr = readCoinbaseRate(idrRates, 'USDT');

      return {
        asset: assetConfig.asset,
        name: assetConfig.name,
        idrRate: 1 / usdtPerIdr,
        apiDate: '',
        provider: 'COINBASE',
      };
    } catch {
      // Fall through to the existing Fawaz asset source.
    }
  }

  const { data, provider } = await fetchCurrencyFile(code, code !== 'xau');
  const assetMap = readCurrencyMap(data, code);
  const idrRate = assetMap.idr;
  if (typeof idrRate !== 'number' || idrRate <= 0) {
    throw new Error(`Fawaz response missing "${code}.idr" rate`);
  }

  const apiDate = readApiDate(data);
  if (code === 'xaut' || code === 'xau') {
    return {
      asset: assetConfig.asset,
      name: assetConfig.name,
      idrPerTroyOunce: idrRate,
      idrPerGram: idrRate / TROY_OUNCE_GRAMS,
      idrRate,
      apiDate,
      provider,
    };
  }

  return {
    asset: assetConfig.asset,
    name: assetConfig.name,
    idrRate,
    apiDate,
    provider,
  };
}

function buildUsdtAssetFromUsdRates(usdRates: Record<string, unknown>): AssetPrice {
  const idrPerUsd = readCoinbaseRate(usdRates, 'IDR');
  const usdtPerUsd = readCoinbaseRate(usdRates, 'USDT');

  return {
    asset: 'USDT',
    name: 'Tether USD',
    idrRate: idrPerUsd / usdtPerUsd,
    apiDate: '',
    provider: 'COINBASE',
  };
}

async function fetchAssetsToIdr(usdRates?: Record<string, unknown>) {
  const results = await Promise.allSettled(ASSETS.map((asset) => {
    if (asset.code === 'usdt' && usdRates) {
      return buildUsdtAssetFromUsdRates(usdRates);
    }

    return fetchAssetToIdr(asset.code);
  }));
  return results
    .filter((result): result is PromiseFulfilledResult<AssetPrice> => result.status === 'fulfilled')
    .map((result) => result.value);
}

async function fetchCoinbaseRatesAgainstIdr(): Promise<FetchResult> {
  const usdRates = await fetchCoinbaseRates('USD');
  const assets = await fetchAssetsToIdr(usdRates);
  const idrPerUsd = readCoinbaseRate(usdRates, 'IDR');
  const rates: Rates = {};

  for (const pair of ALL_PAIRS) {
    if (pair.code === 'USD') {
      rates[pair.code] = idrPerUsd;
      continue;
    }

    const pairPerUsd = readCoinbaseRate(usdRates, pair.code);
    rates[pair.code] = idrPerUsd / pairPerUsd;
  }

  return {
    rates,
    assets,
    provider: 'COINBASE',
    updatedAt: new Date().toISOString(),
  };
}

async function fetchFawazRatesAgainstIdr(): Promise<FetchResult> {
  const [{ data, provider }, assets] = await Promise.all([
    fetchCurrencyFile('idr'),
    fetchAssetsToIdr(),
  ]);
  const idrRates = readCurrencyMap(data, 'idr');
  const rates: Rates = {};

  for (const pair of ALL_PAIRS) {
    const code = pair.code.toLowerCase();
    const value = idrRates[code];
    if (typeof value !== 'number' || value <= 0) {
      throw new Error(`Fawaz response missing "idr.${code}" rate`);
    }
    rates[pair.code] = 1 / value;
  }

  return {
    rates,
    assets,
    provider,
    updatedAt: new Date().toISOString(),
    sourceDate: readApiDate(data),
  };
}

async function fetchRatesAgainstIdr(): Promise<FetchResult> {
  try {
    return await fetchCoinbaseRatesAgainstIdr();
  } catch (coinbaseError) {
    try {
      return await fetchFawazRatesAgainstIdr();
    } catch (fawazError) {
      const coinbaseMessage = coinbaseError instanceof Error ? coinbaseError.message : String(coinbaseError);
      const fawazMessage = fawazError instanceof Error ? fawazError.message : String(fawazError);
      throw new Error(`Currency APIs failed: Coinbase ${coinbaseMessage}; Fawaz ${fawazMessage}`);
    }
  }
}

function chartPointsWithLiveCurrent(
  chartPoints: IdxChartPoint[],
  current: FetchResult | null,
) {
  if (!current) return chartPoints;

  const livePoint: IdxChartPoint = {
    timestamp: current.updatedAt,
    idx: computeIDX(current.rates, BASELINE_RATES_2000),
    rates: current.rates,
    isSynthetic: false,
  };

  const previousPoints = chartPoints.filter((point) => (
    new Date(point.timestamp).getTime() < new Date(current.updatedAt).getTime()
  ));

  return [...previousPoints, livePoint];
}

export async function getDashboardData(): Promise<DashboardData> {
  const { getStoredDashboardData } = await import('./snapshots');
  const [stored, current] = await Promise.all([
    getStoredDashboardData(),
    fetchRatesAgainstIdr().then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    ),
  ]);
  const currentValue = current.status === 'fulfilled'
    ? current.value
    : stored?.current ?? null;

  return {
    current: currentValue,
    yesterday: stored?.yesterday ?? null,
    chartPoints: chartPointsWithLiveCurrent(
      stored?.chartPoints ?? [],
      currentValue,
    ),
    error: current.status === 'rejected'
      ? current.reason instanceof Error ? current.reason.message : String(current.reason)
      : undefined,
  };
}

export function computeIDX(rates: Rates, baseline: Rates | null) {
  if (!baseline) return 100;
  let logSum = 0;
  let weightSum = 0;

  for (const pair of PAIRS) {
    if (rates[pair.code] && baseline[pair.code]) {
      const strength = baseline[pair.code] / rates[pair.code];
      const weight = pair.weight ?? 0;
      logSum += weight * Math.log(strength);
      weightSum += weight;
    }
  }

  return weightSum ? 100 * Math.exp(logSum / weightSum) : 100;
}

export function fmt(n: number, decimals = 2) {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtIDR(n: number) {
  if (n >= 10000) return fmt(n, 0);
  if (n >= 1000) return fmt(n, 1);
  if (n >= 100) return fmt(n, 2);
  if (n >= 1) return fmt(n, 4);
  return n.toFixed(6);
}
