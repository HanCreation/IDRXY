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
  previous?: FetchResult | null;
  yesterday?: FetchResult | null;
  comparison?: {
    label: string;
    timestamp: string;
  } | null;
  bondMarket?: import('./bonds').BondMarketRow[];
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
  const stored = await getStoredDashboardData();
  const currentValue = stored?.current ?? null;

  return {
    current: currentValue,
    previous: stored?.previous ?? null,
    yesterday: stored?.previous ?? null,
    comparison: stored?.comparison ?? null,
    chartPoints: chartPointsWithLiveCurrent(stored?.chartPoints ?? [], currentValue),
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
