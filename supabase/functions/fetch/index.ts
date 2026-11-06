import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Pair = {
  code: string;
  weight?: number;
};

type Rates = Record<string, number>;

type AssetPrice = {
  asset: "USDT" | "XAU" | "XAUT";
  name: string;
  idrRate: number;
  idrPerTroyOunce?: number;
  idrPerGram?: number;
  apiDate: string;
  provider: string;
};

type CoinbaseExchangeRatesResponse = {
  data?: {
    currency?: unknown;
    rates?: Record<string, unknown>;
  };
};

type FawazCurrencyResponse = {
  date?: unknown;
  [currency: string]: unknown;
};

type YieldMap = Record<string, number>;

type BondYieldRow = {
  country_code: "US" | "ID";
  country_name: string;
  observation_date: string;
  source: string;
  yields: YieldMap;
  raw: unknown;
};

const PAIRS: Pair[] = [
  { code: "USD", weight: 0.25 },
  { code: "SGD", weight: 0.18 },
  { code: "EUR", weight: 0.15 },
  { code: "JPY", weight: 0.12 },
  { code: "GBP", weight: 0.08 },
  { code: "AUD", weight: 0.07 },
  { code: "CNY", weight: 0.08 },
  { code: "KRW", weight: 0.04 },
  { code: "MYR", weight: 0.03 },
];

const ADDITIONAL_PAIRS: Pair[] = [
  { code: "THB" },
  { code: "PHP" },
  { code: "VND" },
  { code: "INR" },
  { code: "HKD" },
  { code: "TWD" },
  { code: "NZD" },
  { code: "CAD" },
  { code: "CHF" },
  { code: "SAR" },
  { code: "AED" },
  { code: "TRY" },
];

const ALL_PAIRS = [...PAIRS, ...ADDITIONAL_PAIRS];

// IDR per 1 foreign-currency unit, effective 03-01-2000 to 09-01-2000.
// Note: JPY source is per 100 JPY, so it is divided by 100 here.
const BASELINE_RATES_2000: Rates = {
  AUD: 4484.14,
  CNY: 839.3923,
  EUR: 6979.89,
  GBP: 11219.39,
  JPY: 67.8247,
  KRW: 6.1613,
  MYR: 1828.95,
  SGD: 4165.92,
  USD: 6950.00,
};

const TROY_OUNCE_GRAMS = 31.1034768;
const FX_TIMEOUT_MS = 10_000;
const FX_MAX_RETRIES = 5;
const FX_RETRY_DELAY_MS = 500;
const BOND_REFRESH_HOURS = 1;

const COINBASE_IDR_EXCHANGE_RATES_API =
  "https://api.coinbase.com/v2/exchange-rates?currency=IDR";

const FAWAZ_PRIMARY_CDN =
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies";

const FAWAZ_FALLBACK_CDN =
  "https://latest.currency-api.pages.dev/v1/currencies";

const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: RESPONSE_HEADERS,
  });
}

function floorToFiveMinuteBucket(date = new Date()) {
  const bucketMs = 5 * 60 * 1000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs).toISOString();
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function readRequestBody(req: Request) {
  try {
    if (req.method === "GET") return {};
    return await req.json();
  } catch {
    return {};
  }
}

async function fetchTextWithTimeout(url: string, timeoutMs = FX_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const text = await res.text();
    if (res.status !== 200 || /awsWafCookieDomainList|gokuProps|captcha|verify you are human/i.test(text)) {
      throw new Error(`Bond source rejected: HTTP ${res.status}; data page unavailable or bot challenge`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithTimeout<T = unknown>(
  url: string,
  timeoutMs = FX_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "idrxy-supabase-cron/1.0",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
    }

    return await res.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithRetry<T = unknown>(
  url: string,
  options: {
    maxAttempts?: number;
    delayMs?: number;
    validate?: (data: T) => void;
  } = {},
): Promise<T> {
  const {
    maxAttempts = FX_MAX_RETRIES,
    delayMs = FX_RETRY_DELAY_MS,
    validate,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const data = await fetchJsonWithTimeout<T>(url);
      validate?.(data);
      return data;
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts) break;

      await sleep(delayMs);
    }
  }

  throw new Error(`${getErrorMessage(lastError)} after ${maxAttempts} attempt(s)`);
}

async function fetchTextWithRetry(url: string) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= FX_MAX_RETRIES; attempt += 1) {
    try {
      return await fetchTextWithTimeout(url);
    } catch (error) {
      lastError = error;

      if (attempt === FX_MAX_RETRIES) break;

      await sleep(FX_RETRY_DELAY_MS);
    }
  }

  throw new Error(`${getErrorMessage(lastError)} after ${FX_MAX_RETRIES} attempt(s)`);
}

function htmlToSearchableText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function readCoinbaseRate(rates: Record<string, unknown>, code: string) {
  const normalizedCode = code.toUpperCase();
  const rawValue = rates[normalizedCode];
  const value = typeof rawValue === "string" ? Number(rawValue) : rawValue;

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Coinbase response missing "${normalizedCode}" rate`);
  }

  return value;
}

function validateCoinbaseIdrRatesResponse(body: CoinbaseExchangeRatesResponse) {
  if (
    !body.data ||
    body.data.currency !== "IDR" ||
    !body.data.rates ||
    typeof body.data.rates !== "object"
  ) {
    throw new Error("Invalid Coinbase IDR exchange-rates response");
  }

  for (const pair of ALL_PAIRS) {
    readCoinbaseRate(body.data.rates, pair.code);
  }

  readCoinbaseRate(body.data.rates, "USDT");
}

async function fetchCoinbaseIdrRates() {
  return await fetchJsonWithRetry<CoinbaseExchangeRatesResponse>(
    COINBASE_IDR_EXCHANGE_RATES_API,
    {
      maxAttempts: FX_MAX_RETRIES,
      delayMs: FX_RETRY_DELAY_MS,
      validate: validateCoinbaseIdrRatesResponse,
    },
  );
}

function computeIdrRatesFromCoinbase(coinbaseRates: Record<string, unknown>) {
  const rates: Rates = {};

  for (const pair of ALL_PAIRS) {
    const foreignPerIdr = readCoinbaseRate(coinbaseRates, pair.code);
    rates[pair.code] = 1 / foreignPerIdr;
  }

  return rates;
}

function computeIDX(rates: Rates, baseline: Rates) {
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

function fetchUsdtFromCoinbase(coinbaseRates: Record<string, unknown>): AssetPrice {
  const usdtPerIdr = readCoinbaseRate(coinbaseRates, "USDT");

  return {
    asset: "USDT",
    name: "Tether USD",
    idrRate: 1 / usdtPerIdr,
    apiDate: "",
    provider: "COINBASE",
  };
}

async function fetchFawazCurrencyFile(code: string, minified = true) {
  const normalizedCode = code.toLowerCase();
  const path = `${normalizedCode}${minified ? ".min" : ""}.json`;

  const primaryUrl = `${FAWAZ_PRIMARY_CDN}/${path}`;
  const fallbackUrl = `${FAWAZ_FALLBACK_CDN}/${path}`;

  try {
    return {
      data: await fetchJsonWithTimeout<FawazCurrencyResponse>(primaryUrl),
      provider: "FAWAZ CDN · JSDELIVR",
    };
  } catch (primaryError) {
    try {
      return {
        data: await fetchJsonWithTimeout<FawazCurrencyResponse>(fallbackUrl),
        provider: "FAWAZ CDN · PAGES.DEV",
      };
    } catch (fallbackError) {
      throw new Error(
        `Fawaz failed for ${normalizedCode}: primary ${getErrorMessage(primaryError)}; fallback ${getErrorMessage(fallbackError)}`,
      );
    }
  }
}

function readFawazIdrRate(data: FawazCurrencyResponse, code: string) {
  const normalizedCode = code.toLowerCase();
  const currencyMap = data[normalizedCode];

  if (!currencyMap || typeof currencyMap !== "object" || Array.isArray(currencyMap)) {
    throw new Error(`Fawaz response missing "${normalizedCode}" map`);
  }

  const idrRate = (currencyMap as Record<string, unknown>).idr;

  if (typeof idrRate !== "number" || !Number.isFinite(idrRate) || idrRate <= 0) {
    throw new Error(`Fawaz response missing "${normalizedCode}.idr" rate`);
  }

  return idrRate;
}

function readFawazApiDate(data: FawazCurrencyResponse) {
  return typeof data.date === "string" ? data.date : "";
}

async function fetchFawazAssetToIdr(asset: "XAU" | "XAUT"): Promise<AssetPrice> {
  const code = asset.toLowerCase();
  const { data, provider } = await fetchFawazCurrencyFile(code, code !== "xau");

  const idrRate = readFawazIdrRate(data, code);
  const apiDate = readFawazApiDate(data);

  return {
    asset,
    name: asset === "XAU" ? "Gold Spot" : "Tether Gold",
    idrPerTroyOunce: idrRate,
    idrPerGram: idrRate / TROY_OUNCE_GRAMS,
    idrRate,
    apiDate,
    provider,
  };
}

async function fetchAssets(coinbaseRates: Record<string, unknown>) {
  const assetResults = await Promise.allSettled([
    Promise.resolve(fetchUsdtFromCoinbase(coinbaseRates)),
    fetchFawazAssetToIdr("XAU"),
    fetchFawazAssetToIdr("XAUT"),
  ]);

  const assets = assetResults
    .filter((result): result is PromiseFulfilledResult<AssetPrice> => {
      return result.status === "fulfilled";
    })
    .map((result) => result.value);

  const assetErrors = assetResults
    .filter((result): result is PromiseRejectedResult => {
      return result.status === "rejected";
    })
    .map((result) => getErrorMessage(result.reason));

  return {
    assets,
    assetErrors,
  };
}

const PHEI_CURVE_URL = "https://www.phei.co.id/en-us/Data/Fair-Prices-and-Yield";
const TREASURY_CURVE_URL = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml";
const REQUIRED_MATURITIES = ["1Y", "3Y", "5Y", "10Y"] as const;

function validateBondDate(date: string, now = new Date()) {
  const parsed = new Date(`${date}T00:00:00Z`);
  const today = new Date(now.toISOString().slice(0, 10) + "T00:00:00Z");
  const age = today.getTime() - parsed.getTime();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(age) ||
      parsed.toISOString().slice(0, 10) !== date || age < 0 || age > 7 * 86400000) {
    throw new Error(`Invalid or stale bond observation date: ${date}`);
  }
}

function validateYieldMap(yields: YieldMap) {
  for (const maturity of REQUIRED_MATURITIES) {
    const value = yields[maturity];
    if (!Number.isFinite(value) || value < -5 || value > 100) {
      throw new Error(`Missing or invalid ${maturity} bond yield`);
    }
  }
}

function parsePheiCurve(html: string, now = new Date()): BondYieldRow {
  const dateText = html.match(/<[^>]+id=["'][^"']*IGSYC_tdTgl["'][^>]*>([\s\S]*?)<\//i)?.[1];
  const match = dateText && htmlToSearchableText(dateText).match(/per\s+(\d{1,2})-([a-z]+)-(\d{4})/i);
  if (!match) throw new Error("PHEI curve observation date not found");
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(match[2].toLowerCase()) + 1;
  const date = `${match[3]}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  validateBondDate(date, now);
  const table = html.match(/<table\b[^>]*id=["'][^"']*_gvTenor1["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table) throw new Error("PHEI government yield curve table not found");
  const yields: YieldMap = {};
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => htmlToSearchableText(cell[1]));
    if (cells.length < 3) continue;
    const tenor = Number(cells[0]);
    if ([1, 3, 5, 10].includes(tenor) && /^-?\d+(?:\.\d+)?$/.test(cells[1])) {
      yields[`${tenor}Y`] = Number(cells[1]);
    }
  }
  validateYieldMap(yields);
  return {
    country_code: "ID", country_name: "Indonesia", observation_date: date,
    source: "PHEI_IGSYC", yields,
    raw: { url: PHEI_CURVE_URL, methodology: "Indonesia Government Securities Yield Curve; daily close", observation_date: date },
  };
}

function parseTreasuryCurves(xml: string): BondYieldRow[] {
  const rows: BondYieldRow[] = [];
  for (const entry of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const read = (tag: string) => entry[1].match(new RegExp(`<d:${tag}\\b[^>]*>([^<]+)</d:${tag}>`, "i"))?.[1]?.trim();
    const date = read("NEW_DATE")?.slice(0, 10);
    if (!date) throw new Error("Treasury entry has no observation date");
    const yields: YieldMap = {};
    for (const tenor of [1, 3, 5, 10]) {
      const value = read(`BC_${tenor}YEAR`);
      if (value && /^-?\d+(?:\.\d+)?$/.test(value)) yields[`${tenor}Y`] = Number(value);
    }
    validateYieldMap(yields);
    rows.push({
      country_code: "US", country_name: "United States", observation_date: date,
      source: "US_TREASURY_PAR_YIELD", yields,
      raw: { url: TREASURY_CURVE_URL, methodology: "Daily Treasury Par Yield Curve Rates; daily close", observation_date: date },
    });
  }
  if (!rows.length) throw new Error("Treasury XML contains no yield curve entries");
  return rows.sort((a, b) => b.observation_date.localeCompare(a.observation_date));
}

async function fetchOfficialBondYields(countryCode: "US" | "ID"): Promise<BondYieldRow> {
  if (countryCode === "ID") return parsePheiCurve(await fetchTextWithRetry(PHEI_CURVE_URL));
  const now = new Date();
  // A full year includes the previous business day at month boundaries.
  let url = `${TREASURY_CURVE_URL}?data=daily_treasury_yield_curve&field_tdr_date_value=${now.getUTCFullYear()}`;
  let xml = await fetchTextWithRetry(url);
  if (!/<entry\b/i.test(xml) && now.getUTCMonth() === 0) {
    url = `${TREASURY_CURVE_URL}?data=daily_treasury_yield_curve&field_tdr_date_value=${now.getUTCFullYear() - 1}`;
    xml = await fetchTextWithRetry(url);
  }
  const row = parseTreasuryCurves(xml)[0];
  validateBondDate(row.observation_date, now);
  row.raw = { ...(row.raw as Record<string, unknown>), url };
  return row;
}

async function alreadyFetchedBondsRecently(supabase: ReturnType<typeof createClient>) {
  const cutoff = new Date(Date.now() - BOND_REFRESH_HOURS * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from("bond_yield_snapshots")
    .select("country_code, fetched_at").in("country_code", ["US", "ID"]).gte("fetched_at", cutoff);
  if (error) throw new Error(`Bond freshness query failed: ${error.message}`);
  const countries = new Set((data ?? []).map((row) => row.country_code));
  return countries.has("US") && countries.has("ID");
}

async function saveBondYieldsIfNeeded(supabase: ReturnType<typeof createClient>, options: { force?: boolean }) {
  if (!options.force && await alreadyFetchedBondsRecently(supabase)) {
    return { status: "skipped", reason: "Both bond curves were checked within the last hour", rows_saved: [] as string[], errors: [] as string[] };
  }
  const countries = ["US", "ID"] as const;
  const results = await Promise.allSettled(countries.map(fetchOfficialBondYields));
  const errors: string[] = [];
  const rowsSaved: string[] = [];
  const now = new Date().toISOString();
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === "rejected") {
      errors.push(`${countries[index]} bond fetch failed: ${getErrorMessage(result.reason)}`);
      continue;
    }
    const row = result.value;
    const { error } = await supabase.from("bond_yield_snapshots")
      .upsert({ ...row, fetched_at: now }, { onConflict: "country_code,observation_date" });
    if (error) errors.push(`${row.country_code} upsert failed: ${error.message}`);
    else rowsSaved.push(row.country_code);
  }
  return {
    status: rowsSaved.length === 2 && !errors.length ? "success" : rowsSaved.length ? "partial_success" : "failed",
    rows_saved: rowsSaved, errors,
  };
}

function getServiceRoleKey() {
  const explicitServiceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (explicitServiceRole) return explicitServiceRole;

  const secretKey = Deno.env.get("SUPABASE_SECRET_KEY");
  if (secretKey) return secretKey;

  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!secretKeysRaw) return null;

  try {
    const parsed = JSON.parse(secretKeysRaw);
    return parsed.default ?? parsed.service_role ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: RESPONSE_HEADERS,
    });
  }

  const startedAt = new Date().toISOString();
  const requestBody = await readRequestBody(req) as Record<string, unknown>;

  const forceBonds =
    requestBody.force_bonds === true ||
    new URL(req.url).searchParams.get("force_bonds") === "true";

  const cronSecret = Deno.env.get("CRON_SECRET");
  const authHeader = req.headers.get("Authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return json(
      {
        status: "unauthorized",
        message: "Invalid or missing CRON_SECRET bearer token",
      },
      401,
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = getServiceRoleKey();

  if (!supabaseUrl || !serviceRoleKey) {
    return json(
      {
        status: "failed",
        message: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      },
      500,
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const bucketTs = floorToFiveMinuteBucket();

  let runId: number | null = null;
  let runInsertError: string | null = null;

  const { data: run, error: runError } = await supabase
    .from("fetch_runs")
    .insert({
      status: "running",
      message: "Started combined IDRXY + bond market fetch",
      metadata: {
        bucket_ts: bucketTs,
        source: "supabase_edge_function_fetch",
        force_bonds: forceBonds,
        started_at: startedAt,
      },
    })
    .select("id")
    .single();

  if (runError) {
    runInsertError = runError.message;
  } else if (run) {
    runId = run.id;
  }

  const errors: string[] = [];

  let idrxySummary: unknown = null;
  let bondSummary: unknown = null;

  try {
    const coinbase = await fetchCoinbaseIdrRates();
    const coinbaseRates = coinbase.data!.rates!;

    const rates = computeIdrRatesFromCoinbase(coinbaseRates);
    const idx = computeIDX(rates, BASELINE_RATES_2000);

    const { assets, assetErrors } = await fetchAssets(coinbaseRates);

    const selectedCodes = [...new Set([
      ...ALL_PAIRS.map((pair) => pair.code),
      "USDT",
    ])];

    const selectedCoinbaseRates = Object.fromEntries(
      selectedCodes.map((code) => [code, coinbaseRates[code]]),
    );

    const provider = assetErrors.length > 0 ? "COINBASE + FAWAZ_PARTIAL" : "COINBASE + FAWAZ";

    const { error: upsertError } = await supabase
      .from("idrxy_snapshots")
      .upsert(
        {
          bucket_ts: bucketTs,
          idx,
          rates,
          assets,
          provider,
          raw: {
            coinbase_currency: coinbase.data!.currency,
            selected_coinbase_rates: selectedCoinbaseRates,
            asset_errors: assetErrors,
          },
        },
        {
          onConflict: "bucket_ts",
        },
      );

    if (upsertError) {
      throw upsertError;
    }

    idrxySummary = {
      status: assetErrors.length > 0 ? "partial_success" : "success",
      bucket_ts: bucketTs,
      idx,
      pairs_saved: Object.keys(rates).length,
      assets_saved: assets.map((asset) => asset.asset),
      asset_errors: assetErrors,
    };
  } catch (error) {
    errors.push(`IDRXY failed: ${getErrorMessage(error)}`);
  }

  try {
    const bonds = await saveBondYieldsIfNeeded(supabase, { force: forceBonds });
    bondSummary = bonds;
    errors.push(...bonds.errors);
  } catch (error) {
    errors.push(`Bond market failed: ${getErrorMessage(error)}`);
  }

  const idrxyOk =
    typeof idrxySummary === "object" &&
    idrxySummary !== null &&
    "status" in idrxySummary;

  const status =
    errors.length === 0 && (idrxySummary as { status?: string } | null)?.status === "success"
      ? "success"
      : idrxyOk
        ? "partial_success"
        : "failed";

  const message =
    status === "success"
      ? "Saved combined IDRXY + bond market data"
      : status === "partial_success"
        ? "Saved partial combined data"
        : "Combined fetch failed";

  if (runId) {
    await supabase
      .from("fetch_runs")
      .update({
        status,
        finished_at: new Date().toISOString(),
        message,
        metadata: {
          bucket_ts: bucketTs,
          idrxy: idrxySummary,
          bond_market: bondSummary,
          errors,
          run_insert_error: runInsertError,
        },
      })
      .eq("id", runId);
  }

  return json(
    {
      status,
      message,
      bucket_ts: bucketTs,
      idrxy: idrxySummary,
      bond_market: bondSummary,
      errors,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    },
    status === "success" ? 200 : 502,
  );
});