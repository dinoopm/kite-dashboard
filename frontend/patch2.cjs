const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'src', 'pages', 'Alerts.jsx');
let content = fs.readFileSync(p, 'utf8');
content = content.replace(/\[0m/g, ''); 
fs.writeFileSync(p, content);
