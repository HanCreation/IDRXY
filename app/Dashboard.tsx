'use client';

import { useEffect, useMemo, useState } from 'react';
import { ADDITIONAL_PAIRS, BASELINE_RATES_2000, BASELINE_SOURCE_DATE, computeIDX, fmt, fmtIDR, PAIRS } from './fx';
import type { AssetPrice, DashboardData, IdxChartPoint, Pair } from './fx';

function formatChartTime(timestamp: string) {
  const date = new Date(timestamp);
  const day = date.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  });
  const time = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });

  return `${day} ${time} UTC`;
}

function formatWibTime(timestamp: string) {
  const date = new Date(timestamp);
  const day = date.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    timeZone: 'Asia/Jakarta',
  });
  const time = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta',
  });

  return `${day} ${time} WIB`;
}

function formatComparisonDateTime(timestamp: string) {
  const date = new Date(timestamp);
  const utcDate = date.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return `${utcDate} ${formatUtcTime(timestamp)} / ${formatWibTime(timestamp)}`;
}

function formatUtcTime(timestamp: string) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }) + ' UTC';
}

function chartDisplayIdx(idx: number) {
  return Number(idx.toFixed(2));
}

function isRoundedZero(value: number, decimals: number) {
  return Math.abs(value) < 0.5 * 10 ** -decimals;
}

function IdxLineChart({ points }: { points: IdxChartPoint[] }) {
  const latestTime = points.reduce(
    (latest, point) => Math.max(latest, new Date(point.timestamp).getTime()),
    0,
  );
  const chartMinTime = latestTime - 7 * 24 * 60 * 60 * 1000;
  const chartPoints = points.length === 1
    ? [
      {
        timestamp: new Date(new Date(points[0].timestamp).getTime() - 3 * 60 * 60 * 1000).toISOString(),
        idx: points[0].idx,
        isSynthetic: true,
      },
      points[0],
    ]
    : points.filter((point) => new Date(point.timestamp).getTime() >= chartMinTime);

  if (chartPoints.length < 2) {
    return <div className="idx-chart-empty">WAITING FOR IDRXY SNAPSHOT HISTORY</div>;
  }

  const width = 1000;
  const height = 200;
  const padX = 2;
  const padY = 16;
  const valueForChart = (point: IdxChartPoint) => chartDisplayIdx(point.idx);
  const realValues = chartPoints
    .filter((point) => !point.isSynthetic)
    .map(valueForChart);
  const fallbackLow = Math.min(...(realValues.length ? realValues : chartPoints.map(valueForChart)));
  const normalizedChartPoints = chartPoints.map((point, index) => {
    if (!point.isSynthetic) return point;

    const previousRealIndex = chartPoints
      .slice(0, index)
      .findLastIndex((candidate) => !candidate.isSynthetic);
    const nextRealOffset = chartPoints
      .slice(index + 1)
      .findIndex((candidate) => !candidate.isSynthetic);
    const nextRealIndex = nextRealOffset === -1 ? -1 : index + 1 + nextRealOffset;
    const previousReal = previousRealIndex === -1 ? null : chartPoints[previousRealIndex];
    const nextReal = nextRealIndex === -1 ? null : chartPoints[nextRealIndex];

    if (previousReal && nextReal) {
      const progress = (index - previousRealIndex) / (nextRealIndex - previousRealIndex);

      return {
        ...point,
        idx: previousReal.idx + (nextReal.idx - previousReal.idx) * progress,
      };
    }

    return {
      ...point,
      idx: fallbackLow,
    };
  });
  const values = normalizedChartPoints.map(valueForChart);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const min = rawMin;
  const max = rawMax;
  const range = max - min || 1;
  const coords = normalizedChartPoints.map((point, index) => {
    const displayIdx = valueForChart(point);
    const x = padX + (index / (normalizedChartPoints.length - 1)) * (width - padX * 2);
    const y = height - padY - ((displayIdx - min) / range) * (height - padY * 2);
    return { ...point, x, y };
  });
  const segmentPath = (previous: typeof coords[number], point: typeof coords[number]) => {
    const midX = (previous.x + point.x) / 2;
    return `M${previous.x.toFixed(2)},${previous.y.toFixed(2)} C${midX.toFixed(2)},${previous.y.toFixed(2)} ${midX.toFixed(2)},${point.y.toFixed(2)} ${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  };
  const linePath = coords.reduce((path, point, index) => {
    if (index === 0) return `M${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    const previous = coords[index - 1];
    const midX = (previous.x + point.x) / 2;
    return `${path} C${midX.toFixed(2)},${previous.y.toFixed(2)} ${midX.toFixed(2)},${point.y.toFixed(2)} ${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }, '');
  const fillPath = coords.length > 1
    ? `${linePath} L${coords[coords.length - 1].x.toFixed(2)},${height - padY} L${coords[0].x.toFixed(2)},${height - padY} Z`
    : '';
  const syntheticSegments = coords.slice(1).flatMap((point, index) => {
    const previous = coords[index];
    return previous.isSynthetic || point.isSynthetic ? [segmentPath(previous, point)] : [];
  });
  const realSegments = coords.slice(1).flatMap((point, index) => {
    const previous = coords[index];
    return previous.isSynthetic || point.isSynthetic ? [] : [segmentPath(previous, point)];
  });

  return (
    <div className="idx-chart" aria-label="IDRXY seven day line chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        {fillPath && <path className="idx-chart-fill" d={fillPath} />}
        {syntheticSegments.map((path, index) => (
          <path className="idx-chart-line idx-chart-line-synthetic" d={path} key={`synthetic-${index}`} />
        ))}
        {realSegments.map((path, index) => (
          <path className="idx-chart-line" d={path} key={`real-${index}`} />
        ))}
        {coords.filter((point) => !point.isSynthetic).map((point) => (
            <g className="idx-chart-point" key={point.timestamp}>
              <line x1={point.x} x2={point.x} y1={padY} y2={height - padY} />
              <circle className="idx-chart-hit" cx={point.x} cy={point.y} r="18" />
              <circle className="idx-chart-dot" cx={point.x} cy={point.y} r="3.5" />
              <foreignObject x={Math.min(Math.max(point.x - 300, 8), width - 608)} y={Math.max(point.y - 210, 2)} width="600" height="250">
                <div className="idx-chart-tooltip">
                  <strong>{fmt(point.idx, 2)}</strong>
                  <span>{formatChartTime(point.timestamp)}</span>
                </div>
              </foreignObject>
            </g>
          ))}
      </svg>
    </div>
  );
}

export default function Dashboard({ data }: { data: DashboardData }) {
  const [clock, setClock] = useState('--:--:-- UTC');

  const rates = data.current?.rates || null;
  const yesterday = data.yesterday ?? null;
  const idx = rates ? computeIDX(rates, BASELINE_RATES_2000) : null;
  const previousIdx = yesterday?.rates
    ? computeIDX(yesterday.rates, BASELINE_RATES_2000)
    : null;
  const idxDiff = idx && previousIdx ? idx - previousIdx : 0;
  const idxPct = idx && previousIdx ? (idxDiff / previousIdx) * 100 : 0;
  const hasIdxDiff = Boolean(previousIdx) && !isRoundedZero(idxDiff, 3);
  const hasIdxPct = Boolean(previousIdx) && !isRoundedZero(idxPct, 3);
  const comparisonDateTime = yesterday?.updatedAt
    ? formatComparisonDateTime(yesterday.updatedAt)
    : '';

  useEffect(() => {
    const updateClock = () => setClock(new Date().toUTCString().slice(17, 25) + ' UTC');
    updateClock();
    const timer = window.setInterval(updateClock, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const basketChanges = useMemo(() => {
    if (!rates) return [];
    return PAIRS.map((pair) => {
      const previous = yesterday?.rates[pair.code];
      const ratePct = previous ? ((rates[pair.code] - previous) / previous) * 100 : 0;
      return {
        code: pair.code,
        ratePct,
      };
    }).filter((item) => item.ratePct !== 0);
  }, [rates, yesterday]);

  const strongest = basketChanges.filter((item) => item.ratePct < 0).sort((a, b) => a.ratePct - b.ratePct)[0];
  const weakest = basketChanges.filter((item) => item.ratePct > 0).sort((a, b) => b.ratePct - a.ratePct)[0];
  const signedPct = (value: number, decimals = 2) => `${value >= 0 ? '+' : ''}${value.toFixed(decimals)}%`;

  const renderPairCard = (pair: Pair) => {
    if (!rates) return null;
    const rate = rates[pair.code];
    if (!rate) return null;
    const previous = yesterday?.rates[pair.code];
    const diffPct = previous ? ((rate - previous) / previous) * 100 : 0;
    const hasChange = Boolean(previous) && !isRoundedZero(diffPct, 3);
    const changeClass = !hasChange ? 'change-neutral' : diffPct > 0 ? 'idr-weaker' : 'idr-stronger';

    return (
      <div className="pair-card" key={pair.code}>
        <div className="pair-header">
          <div>
            <div className="pair-name">{pair.code}/IDR</div>
            <div className="pair-currency-name">{pair.name}</div>
          </div>
          <div className="pair-flag">{pair.flag}</div>
        </div>
        <div className="pair-rate">Rp {fmtIDR(rate)}</div>
        <div className="pair-sub">
          <div className={`pair-change ${changeClass}`}>{hasChange ? `${diffPct > 0 ? '▲' : '▼'} ${Math.abs(diffPct).toFixed(3)}%` : '- 0%'}</div>
        </div>
      </div>
    );
  };

  const renderAssetCard = (asset: AssetPrice) => (
    <div className="pair-card asset-card" key={asset.asset}>
      <div className="pair-header">
        <div>
          <div className="pair-name">{asset.asset}/IDR</div>
          <div className="pair-currency-name">{asset.name}</div>
        </div>
        <div className="asset-mark">{asset.asset === 'USDT' ? 'USDT' : 'Au'}</div>
      </div>
      <div className="pair-rate">Rp {fmtIDR(asset.idrPerGram ?? asset.idrRate)}</div>
      <div className="pair-sub">
        <div className="pair-change">{asset.asset === 'XAUT' ? 'PER GRAM [TOKEN]' : asset.idrPerGram ? 'PER GRAM' : 'PER TOKEN'}</div>
        {asset.idrPerTroyOunce && <div className="asset-ounce">OZ Rp {fmtIDR(asset.idrPerTroyOunce)}</div>}
      </div>
    </div>
  );

  return (
    <>
      {['tl', 'tr', 'bl', 'br'].map((corner) => (
        <svg key={corner} className={`batik-corner batik-${corner}`} viewBox="0 0 120 120" fill="none">
          <path d="M0 0 L60 0 L0 60 Z" fill="#d2a550" />
          <circle cx="20" cy="20" r="4" fill="#d2a550" />
          <path d="M30 0 Q40 15 30 30 Q15 40 0 30" stroke="#d2a550" strokeWidth="0.5" fill="none" />
        </svg>
      ))}

      <header className="header">
        <div className="header-logo">IDRXY &nbsp;·&nbsp; INDONESIAN RUPIAH INDEX</div>
        <div className="header-time">{clock}</div>
      </header>

      <main className="main">
        {data.error && <div className="error-msg">API fetch warning: {data.error}. Live values are unavailable.</div>}

        <div className="idx-hero">
          <div className="idx-hero-info">
            <button
              type="button"
              className="idx-hero-info-button"
              aria-label="How IDRXY is calculated"
            >
              i
            </button>
            <div className="idx-hero-info-tooltip" role="tooltip" aria-hidden="true">
              <strong>IDRXY formula</strong>
              <div className="idx-tooltip-formula">100 × exp(Σ(w<sub>i</sub> × ln(B<sub>i</sub> / R<sub>i</sub>)) / Σw<sub>i</sub>)</div>
              <div className="idx-tooltip-note">B = 3 Jan 2000 baseline. R = current IDR per foreign unit. w = basket weight.</div>

              <div className="idx-tooltip-section">
                <span className="idx-tooltip-heading">Basket weights</span>
                <div className="idx-tooltip-grid">
                  <span>USD 25%</span><span>SGD 18%</span><span>EUR 15%</span>
                  <span>JPY 12%</span><span>GBP 8%</span><span>CNY 8%</span>
                  <span>AUD 7%</span><span>KRW 4%</span><span>MYR 3%</span>
                </div>
              </div>

              <div className="idx-tooltip-section">
                <span className="idx-tooltip-heading">Baseline, IDR per 1 unit</span>
                <div className="idx-tooltip-grid">
                  <span>USD 6950.00</span><span>SGD 4165.92</span><span>EUR 6979.89</span>
                  <span>JPY 67.82</span><span>GBP 11219.39</span><span>CNY* 839.39</span>
                  <span>AUD 4484.14</span><span>KRW* 6.16</span><span>MYR 1828.95</span>
                </div>
              </div>

              <div className="idx-tooltip-note">* Derived: 6950 / foreign currency per USD from FRED.</div>
              <div className="idx-tooltip-sources">
                <a href="https://www.pajak.go.id/id/nilai-kurs-sebagai-dasar-pelunasan-bea-masuk-pajak-pertambahan-nilai-barang-dan-jasa-dan-pajak-58" target="_blank" rel="noopener noreferrer">DJP/Kemenkeu</a>
                <a href="https://fred.stlouisfed.org/data/DEXCHUS" target="_blank" rel="noopener noreferrer">FRED CNY</a>
                <a href="https://fred.stlouisfed.org/data/DEXKOUS" target="_blank" rel="noopener noreferrer">FRED KRW</a>
              </div>
            </div>
          </div>
          <div className="idx-label">IDRXY - Composite Rupiah Strength Index (since 2000)</div>
          <div className="idx-main">
            <div className="idx-value">{idx ? fmt(idx, 2) : '-'}</div>
            <div className="idx-change-block">
              <div className={`idx-change ${hasIdxDiff ? idxDiff > 0 ? 'up' : 'down' : 'change-neutral'}`}>{hasIdxDiff ? `${idxDiff > 0 ? '+' : ''}${fmt(idxDiff, 3)}` : '- 0'}</div>
              <div className={`idx-change-pct ${hasIdxPct ? '' : 'change-neutral'}`}>{hasIdxPct ? `${idxPct > 0 ? '+' : ''}${idxPct.toFixed(3)}%` : '- 0%'}</div>
              <div className="idx-yesterday-label">
                {previousIdx && yesterday?.updatedAt
                  ? `vs PREVIOUS WEEKDAY CLOSE (${comparisonDateTime})`
                  : 'vs PREVIOUS WEEKDAY CLOSE (-)'}
              </div>
            </div>
          </div>
          <IdxLineChart points={data.chartPoints ?? []} />
          <div className="idx-meta">
            <div className="idx-meta-item">BASKET <span>{PAIRS.length}</span></div>
            <div className="idx-meta-item">IDR STRONGER VS <span className={strongest ? 'idr-stronger' : ''}>{strongest ? `${strongest.code} (${signedPct(strongest.ratePct)})` : ''}</span></div>
            <div className="idx-meta-item">IDR WEAKER VS <span className={weakest ? 'idr-weaker' : ''}>{weakest ? `${weakest.code} (${signedPct(weakest.ratePct)})` : ''}</span></div>
            <div className="idx-meta-item">UPDATED <span>{data.current ? new Date(data.current.updatedAt).toISOString().slice(11, 19) + ' UTC' : '-'}</span></div>
          </div>
        </div>

        <div className="currency-section currency-section-main">
          <div className="section-label">MAIN IDRXY BASKET vs IDR</div>

          <div className="pairs-grid main-pairs-grid">
            {!rates ? (
              <div className="loading-state">LIVE DATA UNAVAILABLE</div>
            ) : (
              PAIRS.map(renderPairCard)
            )}
          </div>
        </div>

        <div className="currency-section currency-section-additional">
          <div className="section-label section-label-secondary">ADDITIONAL EXCHANGE RATES vs IDR</div>

          <div className="pairs-grid additional-grid">
            {!rates ? (
              <div className="loading-state">LIVE DATA UNAVAILABLE</div>
            ) : (
              ADDITIONAL_PAIRS.map(renderPairCard)
            )}
          </div>
        </div>

        <div className="currency-section currency-section-assets">
          <div className="section-label section-label-secondary">GOLD & TOKEN PRICES vs IDR</div>

          <div className="pairs-grid assets-grid">
            {!data.current?.assets?.length ? (
              <div className="loading-state">ASSET DATA UNAVAILABLE</div>
            ) : (
              data.current.assets.map(renderAssetCard)
            )}
          </div>
        </div>

        <footer className="footer">
          <div className="footer-source">
            <span>SOURCE</span>
            <strong>{data.current ? `FX + USDT: ${data.current.provider}  · XAU/XAUT: FAWAZ   · ${data.current.sourceDate || 'CURRENT'}` : 'FX + USDT: COINBASE  · XAU/XAUT: FAWAZ'}</strong>
          </div>
          <div className="footer-note">
            IDRXY baseline (100 Score) uses {BASELINE_SOURCE_DATE} as the first available market data day. Additional currencies, USDT, XAUT, and XAU are live references only and are not included in the IDRXY score.
          </div>
          <div className="footer-credit">
           ORCHESTRATED BY HAN 2026
          </div>
        </footer>
      </main>
    </>
  );
}
