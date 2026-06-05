// Brand wordmark — "Kite" (light) over "Analytics" (accent blue), tuned for the
// dark navbar. Pure text; sizes scale off the `height` prop.
export default function Logo({ height = 40 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05 }}>
      <span style={{ fontWeight: 800, fontSize: `${height * 0.5}px`, color: '#f1f5f9', letterSpacing: '0.5px' }}>Kite</span>
      <span style={{ fontWeight: 600, fontSize: `${height * 0.3}px`, color: 'var(--accent)', letterSpacing: '1.5px' }}>Analytics</span>
    </div>
  );
}
