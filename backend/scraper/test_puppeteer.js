const puppeteer = require('puppeteer');

async function getEndpoints() {
    console.log("Launching browser...");
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    
    // Set a normal user agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    const apiEndpoints = [];
    page.on('request', request => {
        const url = request.url();
        if (url.includes('/api/')) {
            apiEndpoints.push(url);
        }
    });

    console.log("Navigating to ASM page...");
    try {
        await page.goto('https://www.nseindia.com/regulations/additional-surveillance-measure', { waitUntil: 'networkidle2', timeout: 30000 });
        console.log("Page loaded. Intercepted API calls:");
        console.log([...new Set(apiEndpoints)].join('\n'));
    } catch (e) {
        console.log("Error loading page:", e.message);
    }
    
    await browser.close();
}

getEndpoints();
