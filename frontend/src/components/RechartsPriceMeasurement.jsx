import { usePlotArea, useXAxisScale, useYAxisScale, useXAxisInverseScale, useYAxisInverseScale, ZIndexLayer, DefaultZIndexes } from 'recharts';
import PriceMeasurementOverlay from './PriceMeasurementOverlay';
import { priceMeasurement } from '../lib/priceMeasurement';
import { measurementPrice, measurementAxisValue, measurementTime } from '../lib/rechartsMeasurement';

// Use Recharts' actual scales, including domains extended by support/resistance
// and percentage-comparison series. No estimate from axis labels or data min/max.
export default function RechartsPriceMeasurement({ model, data, base = null, intraday = false, timeZone }) {
  const plot = usePlotArea();
  const xScale = useXAxisScale(), yScale = useYAxisScale();
  const inverseX = useXAxisInverseScale(), inverseY = useYAxisInverseScale();
  if (!plot || !xScale || !yScale || !inverseX || !inverseY) return null;
  const { state } = model;
  const project = point => point && ({ x: xScale(point.date) - plot.x, y: yScale(measurementAxisValue(point.price, base)) - plot.y });
  const from = project(state.start), to = project(state.end || state.preview);
  const valid = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
  const measurement = {
    ...state, result: priceMeasurement(state.start, state.end || state.preview),
    geometry: valid(from) ? { from, to: valid(to) ? to : null, width: plot.width, height: plot.height } : null,
  };
  const pointAt = event => {
    const svg = event.currentTarget.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!matrix) return null;
    const cursor = svg.createSVGPoint();
    cursor.x = event.clientX; cursor.y = event.clientY;
    const p = cursor.matrixTransform(matrix.inverse());
    const date = inverseX(p.x);
    const logical = data.findIndex(row => row.date === date);
    const price = measurementPrice(Number(inverseY(p.y)), base);
    if (logical < 0 || !Number.isFinite(price)) return null;
    return { date, logical, price, ...measurementTime(data[logical], intraday, timeZone) };
  };
  // Series are portalled into ordered layers; the selector must sit above
  // them so filled areas cannot swallow measurement clicks.
  return <ZIndexLayer zIndex={DefaultZIndexes.label + 1}><g className="price-measurement-layer">
    {state.active && <rect data-testid="price-measurement-surface" x={plot.x} y={plot.y} width={plot.width} height={plot.height} fill="transparent" style={{ cursor: 'crosshair', touchAction: 'none' }}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation(); model.select(pointAt(event)); }}
      onPointerMove={event => { event.stopPropagation(); if (state.start) model.preview(pointAt(event)); }} />}
    {measurement.geometry && <foreignObject x={plot.x} y={plot.y} width={plot.width} height={plot.height} style={{ pointerEvents: 'none', overflow: 'hidden' }}>
      <div xmlns="http://www.w3.org/1999/xhtml" style={{ position: 'relative', width: '100%', height: '100%' }}>
        <PriceMeasurementOverlay measurement={measurement} />
      </div>
    </foreignObject>}
  </g></ZIndexLayer>;
}
