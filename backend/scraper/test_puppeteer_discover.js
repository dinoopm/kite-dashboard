const puppeteer = require('puppeteer');

async function test() {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    const apiCalls = [];
    page.on('response', async response => {
        const url = response.url();
        if (url.includes('/api/') && response.status() === 200) {
            const ct = response.headers()['content-type'] || '';
            if (ct.includes('json')) {
                try {
                    const body = await response.json();
                    apiCalls.push({ url, sample: JSON.stringify(body).substring(0, 500) });
                } catch(e) {}
            }
        }
    });

    console.log("Loading https://www.nseindia.com/reports/asm ...");
    await page.goto('https://www.nseindia.com/reports/asm', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    console.log("\n=== Intercepted JSON API calls ===");
    apiCalls.forEach(c => {
        console.log(`URL: ${c.url}`);
        console.log(`Sample: ${c.sample}`);
        console.log('---');
    });

    // Extract tables
    const tableData = await page.evaluate(() => {
        const tables = document.querySelectorAll('table');
        const result = [];
        tables.forEach((table, ti) => {
            const headers = [...table.querySelectorAll('thead th, thead td')].map(h => h.innerText.trim());
            const rows = [...table.querySelectorAll('tbody tr')].slice(0, 5).map(row => {
                return [...row.querySelectorAll('td')].map(td => td.innerText.trim());
            });
            result.push({ tableIndex: ti, headers, rowCount: table.querySelectorAll('tbody tr').length, sampleRows: rows });
        });
        return result;
    });

    console.log("\n=== Tables found in DOM ===");
    tableData.forEach(t => {
        console.log(`Table ${t.tableIndex}: ${t.rowCount} rows`);
        console.log(`Headers: ${t.headers.join(' | ')}`);
        t.sampleRows.forEach(r => console.log(`  Row: ${r.join(' | ')}`));
        console.log('---');
    });

    // Check download buttons
    const downloadBtns = await page.evaluate(() => {
        return [...document.querySelectorAll('a, button')].filter(el => {
            const text = (el.innerText || '').toLowerCase();
            return text.includes('download') || text.includes('csv');
        }).map(el => ({ tag: el.tagName, text: el.innerText.trim().substring(0, 80), href: el.href || '', id: el.id, classes: el.className }));
    });

    console.log("\n=== Download buttons ===");
    downloadBtns.forEach(b => console.log(JSON.stringify(b)));

    await browser.close();
}

test().catch(e => console.error("Fatal:", e.message));
