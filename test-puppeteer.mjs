import puppeteer from 'puppeteer-core';

console.log('Trying to launch Chrome...');

try {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
    ],
  });

  console.log('Chrome launched successfully!');
  
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  await page.goto('https://google.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
  console.log('Page title:', await page.title());
  
  await browser.close();
  console.log('Test passed!');
} catch (e) {
  console.error('Failed:', e.message);
}