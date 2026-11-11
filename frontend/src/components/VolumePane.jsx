import { memo, useMemo } from 'react';
import { ComposedChart, Bar, Line, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { hasTradedVolume, compactVolume } from '../lib/volume';
import { barInterval, relativeVolume, barOpacity, sessionInProgress } from '../lib/relativeVolume';
import SignalScore from './SignalScore';
import { US_VOLUME_STUDY as STUDY } from '../lib/usVolumeStudy';

// Volume bars for the instrument pages, drawn as a short pane under the price
// chart rather than as a second series on it. Volume is counted in shares and
// price in rupees or dollars; sharing one y-axis would either flatten the bars
// to nothing or rescale them into a shape that means nothing.
//
// Both instrument pages render this from one component on purpose. The India
// and US pages began as copies and drifted — the sector drill-down had the same
// history and had to be merged back into pages/sector/SectorDetailPage.jsx.
//
// Alignment with the chart above is by construction, not by eye: the caller
// passes the SAME data array and the SAME left/right margins, so recharts places
// category N at the same x in both panes. Change one margin and you must change
// the other, which is why the prop is required rather than defaulted.
//
// RELATIVE volume. A bar is only "heavy" against what this instrument normally
// trades, so each bar is drawn against its OWN trailing 20-bar average (the
// line), with brightness following the ratio: faint below average, solid at the
// registered 2x. The arithmetic is lib/volumeThrust's — the registered
// `volume_thrust` detector's — so a lime bar here is a firing the scorecard has
// a row for, and the badge beside the pane reports that rule's record.
// Intraday bars are left plain: the open and close are heavy every session, and
// a 20-bar baseline would flag them every day.

const UP = '#10b981';
const DOWN = '#ef4444';
const FLAT = '#64748b';
const THRUST_COLOR = '#a3e635'; // the Signals tab's colour for the same firing
const AVG_COLOR = '#cbd5e1';

// Colour by the day's own direction (close vs open), which is what the bar is
// describing. Colouring by close-vs-previous-close would tell you about a gap
// the bar does not represent. (The thrust FIRING uses close vs previous close,
// because that is how the registered detector defines an up day.)
const barColor = (d) => {
  if (d?.open == null || d?.close == null) return FLAT;
  if (d.close > d.open) return UP;
  if (d.close < d.open) return DOWN;
  return FLAT;
};

function VolumePane({ data, margin, height = 110, fmtAxisDate, market = 'IN' }) {
  const interval = useMemo(() => barInterval(data), [data]);
  const relative = interval === 'daily' || interval === 'weekly';
  const rv = useMemo(() => (relative ? relativeVolume(data) : null), [data, relative]);
  // The trailing average rides along in the chart rows so the line and the bars
  // share one x position per bar.
  const rows = useMemo(() => (rv ? data.map((d, i) => ({ ...d, volAvg: rv.avg[i] })) : data), [data, rv]);
  if (!hasTradedVolume(data)) return null;

  const unit = interval === 'weekly' ? 'week' : 'day';
  const latest = rv?.latest;
  // Today's daily bar is still counting until the close; its ratio rises all
  // session, so it is labelled as a partial reading rather than stated as one.
  const partial = interval === 'daily' && data.length > 0 && sessionInProgress(data[data.length - 1].date, new Date(), market);

  return (
    <div style={{ width: '100%' }}>
      {/* The one-line answer to "is volume high right now", stated against this
          instrument's own normal rather than left for the eye to judge. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.35rem 1rem', fontSize: '0.72rem', color: 'var(--text-secondary)', margin: '0.2rem 0 0.15rem', paddingLeft: margin?.left ?? 0 }}>
        {latest ? (
          <span>
            {partial ? 'Today so far' : `Latest ${unit}`}:{' '}
            <strong style={{ color: latest.heavy ? THRUST_COLOR : 'var(--text-primary)' }}>
              {latest.ratio.toFixed(1)}× its {rv.period}-{unit} average
            </strong>
            {partial
              ? <> · session still open, so this bar is incomplete and the ratio will rise</>
              : latest.pctBusier != null && <> · busier than {latest.pctBusier}% of the {rv.measured - 1} other {unit}s shown</>}
          </span>
        ) : relative ? (
          <span>Relative volume needs {rv.period + 1} {unit}s of history.</span>
        ) : (
          <span>Relative volume is shown on daily bars — intraday volume is always heavy at the open and close.</span>
        )}
        {relative && (
          <span>
            Line = trailing {rv.period}-{unit} average · faint = below it · solid = {rv.mult}× or more
            {interval === 'daily' && <> · <span style={{ color: THRUST_COLOR }}>lime</span> = volume thrust ({rv.mult}× on an up close, first of a run)</>}
          </span>
        )}
        {/* The thrust's track record, where the claim is made. The rule is a
            daily one, so the badge is shown only beside daily bars. */}
        {interval === 'daily' && <SignalScore signal="volume_thrust" label="▮ volume thrust" market={market} />}
      </div>
      {/* What the highlight is worth for a decision, measured. The badge has
          no US record, so the US study's answer sits here instead — and the
          answer is that a heavy up day, on its own, predicted nothing. */}
      {interval === 'daily' && market === 'US' && (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', lineHeight: 1.5, margin: '0 0 0.2rem', paddingLeft: margin?.left ?? 0 }}
             title={`${STUDY.caveats} Full grid: ${STUDY.report}.`}>
          <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Does heavy volume predict anything?</strong>{' '}
          Measured on {STUDY.symbols} {STUDY.benchmark} stocks, {STUDY.from.slice(0, 4)}–{STUDY.to.slice(0, 4)}: in the 10 days after a {rv?.mult ?? 2}× up-day thrust
          ({STUDY.thrust.firings.toLocaleString('en-US')} of them) the median stock ran {STUDY.thrust.median10dExcessPct.toFixed(2)}% against the index —
          indistinguishable from noise (t = {STUDY.thrust.t.toFixed(2)}), and the same at every threshold from {STUDY.thresholds[0].mult}× to {STUDY.thresholds.at(-1).mult}×.
          As a filter on a buy signal it changed nothing either. Use it as context for how many shares changed hands, not as a buy or sell trigger.
        </div>
      )}
      <div style={{ height, width: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={margin} barCategoryGap={1}>
            <XAxis
              dataKey="date"
              stroke="var(--text-secondary)"
              tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
              tickFormatter={fmtAxisDate}
              interval="preserveStartEnd"
              minTickGap={56}
              tickMargin={8}
            />
            {/* Same width as the price chart's axis so the two panes line up, but
                unlabelled — the tick values are in the tooltip and a second column
                of numbers here just competes with the price scale above. */}
            <YAxis width={60} tick={false} axisLine={false} tickLine={false} domain={[0, 'dataMax']} />
            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.04)' }}
              contentStyle={{ backgroundColor: 'var(--bg-dark)', borderColor: 'var(--border)', color: 'var(--text-primary)' }}
              formatter={(v, name, item) => {
                if (name === 'volAvg') return [compactVolume(Math.round(v)), `${rv?.period}-${unit} average`];
                const i = item?.payload ? rows.indexOf(item.payload) : -1;
                const r = rv && i >= 0 ? rv.ratio[i] : null;
                const last = i === rows.length - 1;
                const tag = rv && i >= 0 && rv.thrust[i] ? (partial && last ? ' · volume thrust, provisional until the close' : ' · volume thrust') : (partial && last ? ' · session still open' : '');
                return [r != null ? `${compactVolume(v)} · ${r.toFixed(1)}× its ${rv.period}-${unit} average${tag}` : compactVolume(v), 'Volume'];
              }}
            />
            <Bar dataKey="volume" isAnimationActive={false}>
              {rows.map((d, i) => {
                const firing = interval === 'daily' && rv?.thrust[i];
                const heavy = rv?.heavy[i];
                return (
                  <Cell
                    key={i}
                    fill={firing ? THRUST_COLOR : barColor(d)}
                    fillOpacity={rv ? barOpacity(rv.ratio[i]) : 0.65}
                    stroke={heavy ? (firing ? THRUST_COLOR : 'rgba(255,255,255,0.55)') : undefined}
                    strokeWidth={heavy ? 1 : 0}
                  />
                );
              })}
            </Bar>
            {rv && <Line dataKey="volAvg" type="monotone" stroke={AVG_COLOR} strokeWidth={1.25} strokeOpacity={0.7} dot={false} isAnimationActive={false} connectNulls={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default memo(VolumePane);
