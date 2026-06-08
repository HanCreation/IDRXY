import Dashboard from './Dashboard';
import { getBondMarketData } from './bonds';
import { getDashboardData } from './fx';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const [data, bondMarket] = await Promise.all([
    getDashboardData(),
    getBondMarketData(),
  ]);

  return <Dashboard data={{ ...data, bondMarket }} />;
}
