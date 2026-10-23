import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// The URL is the source of truth, including on refresh and Back/Forward. Keep
// instrument identity and other query parameters when changing only the tab.
export default function useUrlTab(tabs, defaultTab = 'technicals') {
  const location = useLocation();
  const navigate = useNavigate();
  const requested = new URLSearchParams(location.search).get('tab');
  const activeTab = tabs.includes(requested) ? requested : defaultTab;
  const setActiveTab = useCallback(tab => {
    if (!tabs.includes(tab)) return;
    const params = new URLSearchParams(location.search);
    if (params.get('tab') === tab) return;
    params.set('tab', tab);
    navigate({ pathname: location.pathname, search: `?${params}`, hash: location.hash }, {
      state: location.state, preventScrollReset: true,
    });
  }, [tabs, location, navigate]);
  return [activeTab, setActiveTab];
}
