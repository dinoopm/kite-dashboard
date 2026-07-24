import SectorDetailPage from '../sector/SectorDetailPage';
import { US_MARKET } from '../sector/marketConfig';

// US sector drill-down. The page itself is shared with the India market —
// see pages/sector/SectorDetailPage.jsx — and everything market-specific
// lives in US_MARKET.
export default function UsSectorDetail() {
  return <SectorDetailPage market={US_MARKET} />;
}
