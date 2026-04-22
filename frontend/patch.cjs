const fs = require('fs');
const p = require('path').join(__dirname, 'src', 'pages', 'Alerts.jsx');
let c = fs.readFileSync(p, 'utf8');
c = c.replace(/#10b\x1B\[0m981/g, '#10b981');
c = c.replace(/\x1B\[0m/g, ''); // all raw ansi escape sequences
fs.writeFileSync(p, c);
