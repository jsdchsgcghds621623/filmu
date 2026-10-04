const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,          // <-- visible window so YOU can watch
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  // Log EVERY request + response + error
  page.on('request',  r => {
    const u = r.url();
    if (!u.startsWith('data:') && !u.includes('cloudflareinsights') && !u.includes('umami'))
      console.log('→', r.method(), u.slice(0, 160));
  });
  page.on('response', r => {
    const u = r.url();
    if (!u.startsWith('data:') && !u.includes('cloudflareinsights') && !u.includes('umami'))
      console.log('←', r.status(), u.slice(0, 160));
  });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  page.on('console', m => console.log(`[${m.type()}]`, m.text().slice(0, 200)));

  const url = 'https://embed.filmu.in/tv/93405/1/1?debug=savu';
  console.log('Navigating to', url);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  console.log('\n── after domcontentloaded ──');
  console.log('URL:  ', page.url());
  console.log('Title:', await page.title());

  await page.waitForTimeout(15000);

  console.log('\n── after 15s ──');
  console.log('URL:  ', page.url());
  console.log('Title:', await page.title());
  console.log('Body length:', (await page.content()).length);
  console.log('Root innerHTML length:', await page.evaluate(() =>
    document.getElementById('root')?.innerHTML?.length ?? -1
  ));

  await page.screenshot({ path: 'debug2.png', fullPage: true });
  console.log('\nScreenshot → debug2.png');

  await browser.close();
})();