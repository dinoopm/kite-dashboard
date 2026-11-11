import { useId } from 'react';
import { getRecentTradingDays } from '../lib/tradingDays';
import './TradingDayStrip.css';

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
});

function TradingDayStrip({ candles, loading = false }) {
  const id = useId();
  const days = getRecentTradingDays(candles);

  if (!days.length) {
    const label = loading ? 'Loading last five trading days' : 'Five-day trading history unavailable';
    return (
      <div className={`trading-day-strip${loading ? ' is-loading' : ''}`} role="img" aria-label={label} title={label}>
        <span className="trading-day-label" aria-hidden="true">Last 5</span>
        <span className="trading-day-cells" aria-hidden="true">
          {Array.from({ length: 5 }, (_, index) => (
            <span key={index} className="trading-day-placeholder">
              <span className="trading-day-square trading-day-square--unavailable" />
            </span>
          ))}
        </span>
      </div>
    );
  }

  return (
    <div className="trading-day-strip" role="group" aria-label="Last five trading days, oldest to newest">
      <span className="trading-day-label" aria-hidden="true">Last 5</span>
      <div className="trading-day-cells">
        {days.map(({ date, changePct }, index) => {
          const direction = changePct === null ? 'unavailable' : changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat';
          const percentage = changePct === null ? 'Unavailable' : `${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%`;
          const dateLabel = dateFormatter.format(new Date(`${date}T00:00:00Z`));
          const tooltipId = `${id}-${date}`;
          const arrow = direction === 'up' ? '↗' : direction === 'down' ? '↘' : '−';

          return (
            <button
              key={date}
              type="button"
              className="trading-day"
              style={{ '--trading-day-index': index, '--trading-day-count': days.length }}
              title=""
              aria-label={`${dateLabel}: ${direction}, ${percentage}`}
              aria-describedby={tooltipId}
              onClick={event => event.stopPropagation()}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
              }}
            >
              <span className={`trading-day-square trading-day-square--${direction}`} aria-hidden="true" />
              <span className="trading-day-tooltip" id={tooltipId} role="tooltip">
                <span className="trading-day-tooltip-date">{dateLabel}</span>
                <span className={`trading-day-tooltip-value trading-day-change--${direction}`}>
                  {changePct !== null && <span className="trading-day-tooltip-arrow" aria-hidden="true">{arrow}</span>}
                  <strong>{percentage}</strong>
                </span>
                <span className="trading-day-tooltip-caption">vs previous close</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default TradingDayStrip;
