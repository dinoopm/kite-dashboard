const puppeteer = require('puppeteer');

async function scrapeSurveillance() {
    console.log("Launching browser...");
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    // Scrape ASM
    console.log("Navigating to ASM page...");
    await page.goto('https://www.nseindia.com/regulations/additional-surveillance-measure', { waitUntil: 'networkidle2' });
    
    const asmStocks = await page.evaluate(() => {
        const rows = document.querySelectorAll('table tbody tr');
        const data = [];
        rows.forEach(r => {
             const cols = r.querySelectorAll('td');
             if(cols.length > 2) {
                 // Usually Symbol is in 2nd or 3rd column
                 data.push(cols[1].innerText.trim() + " - " + cols[2].innerText.trim());
             }
        });
        return data;
    });
    
    console.log("ASM Stocks Sample:", asmStocks.slice(0, 10));

    // Scrape GSM
    console.log("Navigating to GSM page...");
    await page.goto('https://www.nseindia.com/regulations/graded-surveillance-measure', { waitUntil: 'networkidle2' });
    
    const gsmStocks = await page.evaluate(() => {
        const rows = document.querySelectorAll('table tbody tr');
        const data = [];
        rows.forEach(r => {
             const cols = r.querySelectorAll('td');
             if(cols.length > 2) {
                 data.push(cols[1].innerText.trim() + " - " + cols[2].innerText.trim());
             }
        });
        return data;
    });

    console.log("GSM Stocks Sample:", gsmStocks.slice(0, 10));

    await browser.close();
}

scrapeSurveillance();
