import { memo } from 'react';
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { hasTradedVolume, averageVolume, compactVolume } from '../lib/volume';

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

const UP = '#10b981';
const DOWN = '#ef4444';
const FLAT = '#64748b';

// Colour by the day's own direction (close vs open), which is what the bar is
// describing. Colouring by close-vs-previous-close would tell you about a gap
// the bar does not represent.
const barColor = (d) => {
  if (d?.open == null || d?.close == null) return FLAT;
  if (d.close > d.open) return UP;
  if (d.close < d.open) return DOWN;
  return FLAT;
};

function VolumePane({ data, margin, height = 90, fmtAxisDate, avgWindow = 20 }) {
  if (!hasTradedVolume(data)) return null;

  // Average of the last N bars, drawn as a reference the eye can use: a bar is
  // only "heavy" relative to what this instrument normally trades.
  const avg = averageVolume(data, avgWindow);

  return (
    <div style={{ height, width: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={margin} barCategoryGap={1}>
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
            formatter={(v) => [
              avg ? `${compactVolume(v)} (${(v / avg).toFixed(1)}× ${avgWindow}-bar avg)` : compactVolume(v),
              'Volume',
            ]}
          />
          <Bar dataKey="volume" isAnimationActive={false}>
            {data.map((d, i) => <Cell key={i} fill={barColor(d)} fillOpacity={0.65} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default memo(VolumePane);
