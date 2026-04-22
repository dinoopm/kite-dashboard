const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'src', 'pages', 'Alerts.jsx');
let content = fs.readFileSync(p, 'utf8');
content = content.replace(/\x1b\[[0-9;]*m/g, ''); // strip ansi
const cleaned = content.replace(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/g, ''); // strip other invisibles
fs.writeFileSync(p, cleaned);
