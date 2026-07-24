import SectorDetailPage from './sector/SectorDetailPage';
import { INDIA_MARKET } from './sector/marketConfig';

// India sector drill-down. The page itself is shared with the US market —
// see pages/sector/SectorDetailPage.jsx — and everything market-specific
// lives in INDIA_MARKET.
export default function SectorDetail() {
  return <SectorDetailPage market={INDIA_MARKET} />;
}
