const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(overrides = {}) {
  const code = fs.readFileSync('supabase/functions/fetch/index.ts', 'utf8')
    .replace(/^import .*createClient.*;\n/, '') + '\n globalThis.api = { parsePheiCurve, parseTreasuryCurves, validateBondDate, fetchTextWithTimeout, saveBondYieldsIfNeeded };';
  const context = { Response, Request, AbortController, URL, setTimeout, clearTimeout,
    Deno: { serve: handler => { context.handler = handler; }, env: { get: name => ({ CRON_SECRET: 'test-secret', SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service' })[name] } },
    fetch: async () => { throw new Error('unexpected network request'); }, ...overrides };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context;
}

const phei = `<div id="dnn_ctr1421_GovernmentBondBenchmark_idIGSYC_tdTgl">per 5-November-2026</div>
<table id="dnn_ctr1421_GovernmentBondBenchmark_gvTenor1">
<tr><th>Tenor Year</th><th>Today</th><th>Yesterday</th></tr>
<tr><td>1.0</td><td>6.8466</td><td>6.9168</td></tr>
<tr><td>3.0</td><td>7.2747</td><td>7.3254</td></tr>
<tr><td>5.0</td><td>7.5135</td><td>7.5879</td></tr>
<tr><td>10.0</td><td>7.7040</td><td>7.7243</td></tr></table>`;
const treasury = `<feed><entry><content><m:properties>
<d:NEW_DATE m:type="Edm.DateTime">2026-11-05T00:00:00</d:NEW_DATE>
<d:BC_1YEAR m:type="Edm.Double">4.28</d:BC_1YEAR><d:BC_3YEAR m:type="Edm.Double">4.53</d:BC_3YEAR>
<d:BC_5YEAR m:type="Edm.Double">4.59</d:BC_5YEAR><d:BC_10YEAR m:type="Edm.Double">4.84</d:BC_10YEAR>
</m:properties></content></entry></feed>`;

test('PHEI reads government curve today column and keeps provider observation date', () => {
  const row = load().api.parsePheiCurve(phei, new Date('2026-11-06T04:00:00Z'));
  assert.equal(row.observation_date, '2026-11-05');
  assert.equal(row.source, 'PHEI_IGSYC');
  assert.deepEqual(JSON.parse(JSON.stringify(row.yields)), { '1Y': 6.8466, '3Y': 7.2747, '5Y': 7.5135, '10Y': 7.704 });
});

test('Treasury extracts all four par yields from namespaced XML', () => {
  const row = load().api.parseTreasuryCurves(treasury)[0];
  assert.equal(row.observation_date, '2026-11-05');
  assert.deepEqual(JSON.parse(JSON.stringify(row.yields)), { '1Y': 4.28, '3Y': 4.53, '5Y': 4.59, '10Y': 4.84 });
});

test('incomplete curves, unrelated tables and stale dates are rejected', () => {
  const api = load().api;
  const now = new Date('2026-11-06T04:00:00Z');
  assert.throws(() => api.parsePheiCurve(phei.replace('<td>7.7040</td>', '<td>N/A</td>'), now), /10Y/);
  assert.throws(() => api.parsePheiCurve(phei.replace('_gvTenor1', '_corporate'), now), /table not found/);
  assert.throws(() => api.validateBondDate('2026-10-24', now), /stale/);
  assert.throws(() => api.validateBondDate('2026-11-07', now), /stale/);
  assert.throws(() => api.parseTreasuryCurves(treasury.replace('<d:BC_3YEAR m:type="Edm.Double">4.53</d:BC_3YEAR>', '')), /3Y/);
});

test('HTTP 202 bot checks are rejected even though Response.ok is true', async () => {
  const { api } = load({ fetch: async () => new Response('<script>window.gokuProps={}</script>', { status: 202 }) });
  await assert.rejects(api.fetchTextWithTimeout('https://example.test'), /HTTP 202.*bot challenge/);
});

function mockDatabase(failCountry) {
  const saves = [];
  const db = { from: table => {
    if (table === 'bond_yield_snapshots') return {
      upsert: async row => { saves.push(row); return { error: row.country_code === failCountry ? { message: 'write rejected' } : null }; },
    };
    if (table === 'fetch_runs') return {
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 1 }, error: null }) }) }),
      update: row => ({ eq: async () => { db.run = row; } }),
    };
    if (table === 'idrxy_snapshots') return { upsert: async () => ({ error: null }) };
    throw new Error(`Unexpected table ${table}`);
  }};
  return { db, saves };
}

test('only successful database writes appear in rows_saved', async () => {
  const { db } = mockDatabase('ID');
  const ctx = load();
  vm.runInContext('fetchOfficialBondYields = async code => ({ country_code: code, country_name: code, observation_date: "2026-11-05", source: "TEST", yields: {"1Y":4,"3Y":4,"5Y":4,"10Y":4}, raw: {} });', ctx);
  const result = await ctx.api.saveBondYieldsIfNeeded(db, { force: true });
  assert.equal(result.status, 'partial_success');
  assert.deepEqual(Array.from(result.rows_saved), ['US']);
  assert.match(result.errors[0], /ID upsert failed/);
});

test('bond-only failure is exposed in overall status, log metadata and HTTP response', async () => {
  const { db } = mockDatabase();
  const ctx = load({ createClient: () => db });
  vm.runInContext(`fetchCoinbaseIdrRates = async () => ({data:{currency:'IDR',rates:{}}});
    computeIdrRatesFromCoinbase = () => ({}); fetchAssets = async () => ({assets:[],assetErrors:[]});
    saveBondYieldsIfNeeded = async () => ({status:'failed',rows_saved:[],errors:['US blocked','ID blocked']});`, ctx);
  const response = await ctx.handler(new Request('https://example.test', { headers: { Authorization: 'Bearer test-secret' } }));
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.status, 'partial_success');
  assert.deepEqual(body.errors, ['US blocked', 'ID blocked']);
  assert.equal(db.run.status, 'partial_success');
  assert.equal(db.run.metadata.bond_market.status, 'failed');
});
