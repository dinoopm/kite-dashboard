// Run once: node add_capital_goods_sector.js
// Adds the NSE:NIFTY CAPITAL GOODS sector to sector_constituents.
// Idempotent: clears any existing rows for this sector_key, then re-inserts.
require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SECTOR_KEY = 'NSE:NIFTY CAPITAL GOODS';

// [symbol, name, isin]
const CONSTITUENTS = [
  ['ABB', 'ABB India Ltd.', 'INE117A01022'],
  ['AIAENG', 'AIA Engineering Ltd.', 'INE212H01026'],
  ['APLAPOLLO', 'APL Apollo Tubes Ltd.', 'INE702C01027'],
  ['APARINDS', 'Apar Industries Ltd.', 'INE372A01015'],
  ['ASHOKLEY', 'Ashok Leyland Ltd.', 'INE208A01029'],
  ['ASTRAMICRO', 'Astra Microwave Products Ltd.', 'INE386C01029'],
  ['ASTRAL', 'Astral Ltd.', 'INE006I01046'],
  ['BEML', 'BEML Ltd.', 'INE258A01024'],
  ['BDL', 'Bharat Dynamics Ltd.', 'INE171Z01026'],
  ['BEL', 'Bharat Electronics Ltd.', 'INE263A01024'],
  ['BHEL', 'Bharat Heavy Electricals Ltd.', 'INE257A01026'],
  ['CGPOWER', 'CG Power and Industrial Solutions Ltd.', 'INE067A01029'],
  ['CARBORUNIV', 'Carborundum Universal Ltd.', 'INE120A01034'],
  ['COCHINSHIP', 'Cochin Shipyard Ltd.', 'INE704P01025'],
  ['CUMMINSIND', 'Cummins India Ltd.', 'INE298A01020'],
  ['DATAPATTNS', 'Data Patterns (India) Ltd.', 'INE0IX101010'],
  ['ELGIEQUIP', 'Elgi Equipments Ltd.', 'INE285A01027'],
  ['ESCORTS', 'Escorts Kubota Ltd.', 'INE042A01014'],
  ['FINCABLES', 'Finolex Cables Ltd.', 'INE235A01022'],
  ['FINPIPE', 'Finolex Industries Ltd.', 'INE183A01024'],
  ['GVT&D', 'GE Vernova T&D India Ltd.', 'INE200A01026'],
  ['GRSE', 'Garden Reach Shipbuilders & Engineers Ltd.', 'INE382Z01011'],
  ['HBLENGINE', 'HBL Engineering Ltd.', 'INE292B01021'],
  ['HAL', 'Hindustan Aeronautics Ltd.', 'INE066F01020'],
  ['POWERINDIA', 'Hitachi Energy India Ltd.', 'INE07Y701011'],
  ['HONAUT', 'Honeywell Automation India Ltd.', 'INE671A01010'],
  ['INOXWIND', 'Inox Wind Ltd.', 'INE066P01011'],
  ['JYOTICNC', 'Jyoti CNC Automation Ltd.', 'INE980O01024'],
  ['KEI', 'KEI Industries Ltd.', 'INE878B01027'],
  ['KAYNES', 'Kaynes Technology India Ltd.', 'INE918Z01012'],
  ['KIRLOSENG', 'Kirloskar Oil Eng Ltd.', 'INE146L01010'],
  ['MAZDOCK', 'Mazagoan Dock Shipbuilders Ltd.', 'INE249Z01020'],
  ['PTCIL', 'PTC Industries Ltd.', 'INE596F01018'],
  ['POLYCAB', 'Polycab India Ltd.', 'INE455K01017'],
  ['PRAJIND', 'Praj Industries Ltd.', 'INE074A01025'],
  ['PREMIERENE', 'Premier Energies Ltd.', 'INE0BS701011'],
  ['ENRIN', 'Siemens Energy India Ltd.', 'INE1NPP01017'],
  ['SIEMENS', 'Siemens Ltd.', 'INE003A01024'],
  ['SUPREMEIND', 'Supreme Industries Ltd.', 'INE195A01028'],
  ['SUZLON', 'Suzlon Energy Ltd.', 'INE040H01021'],
  ['TDPOWERSYS', 'TD Power Systems Ltd.', 'INE419M01027'],
  ['TMCV', 'Tata Motors Ltd.', 'INE1TAE01010'],
  ['THERMAX', 'Thermax Ltd.', 'INE152A01029'],
  ['TIMKEN', 'Timken India Ltd.', 'INE325A01013'],
  ['TITAGARH', 'Titagarh Rail Systems Ltd.', 'INE615H01020'],
  ['TRITURBINE', 'Triveni Turbine Ltd.', 'INE152M01016'],
  ['USHAMART', 'Usha Martin Ltd.', 'INE228A01035'],
  ['VOLTAMP', 'Voltamp Transformers Ltd', 'INE540H01012'],
  ['WAAREEENER', 'Waaree Energies Ltd.', 'INE377N01017'],
  ['WELCORP', 'Welspun Corp Ltd.', 'INE191B01025'],
];

async function main() {
  const rows = CONSTITUENTS.map(([symbol, name, isin], i) => ({
    sector_key: SECTOR_KEY, symbol, name, isin, sort_order: i + 1,
  }));

  console.log(`Clearing existing rows for ${SECTOR_KEY}...`);
  const { error: delErr } = await supabase
    .from('sector_constituents').delete().eq('sector_key', SECTOR_KEY);
  if (delErr) { console.error('Delete failed:', delErr.message); process.exit(1); }

  console.log(`Inserting ${rows.length} rows...`);
  const { error } = await supabase.from('sector_constituents').insert(rows);
  if (error) { console.error('Insert failed:', error.message); process.exit(1); }

  console.log(`Done! ${SECTOR_KEY} seeded with ${rows.length} constituents.`);
}

main().catch(console.error);
