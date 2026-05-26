import Dashboard from './Dashboard';
import { getDashboardData } from './fx';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const data = await getDashboardData();
  return <Dashboard data={data} />;
}
