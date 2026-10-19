const { chromium } = require('playwright');
const { google } = require('googleapis');

const SPREADSHEET_ID = '1hUtPgK-tCE0GOUmjkfjrVBlGVylxKNddVeK1_5xarDY';
const SHEET_NAME = 'Sheet1';

// ==== CONFIG (bench comes from GitHub; falls back to Amravati locally) ====
const BENCH = {
  value: process.env.BENCH_VALUE || 'amravati',
  label: process.env.BENCH_LABEL || 'Amravati'
};
const DATE_WINDOW_DAYS = 45;
const DISPOSED_ONLY = true;
// =========================================================================

const DELAY_BETWEEN_CASES_MS = 2500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanText(s) {
  if (!s) return s;
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).trim();
}

function getDateRange() {
  const fmt = d => String(d.getDate()).padStart(2, '0') + '/' +
                   String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
  const today = new Date();
  const past = new Date();
  past.setDate(today.getDate() - DATE_WINDOW_DAYS);
  return { fromDate: fmt(past), toDate: fmt(today) };
}

async function runSearch(page, benchValue, fromDate, toDate) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`  Search attempt ${attempt}...`);
    await page.goto('https://nclt.gov.in/order-date-wise', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#bench', { timeout: 60000 });
    await page.waitForTimeout(2000);

    await page.selectOption('#bench', benchValue);

    await page.evaluate(({ fromDate, toDate }) => {
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        el.removeAttribute('readonly');
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal('fromdate', fromDate);
      setVal('todate', toDate);
    }, { fromDate, toDate });

    // Wait until the CAPTCHA actually has digits (not empty)
    let captchaText = '';
    for (let i = 0; i < 20; i++) {
      const raw = await page.locator('#mainCaptcha').textContent();
      captchaText = (raw || '').replace(/\s/g, '');
      if (captchaText.length >= 4) break;
      await page.waitForTimeout(500);
    }
    console.log(`    CAPTCHA read as: "${captchaText}"`);

    // Also log what's actually in the dropdown/date fields right before submit
    const formState = await page.evaluate(() => ({
      bench: document.getElementById('bench')?.value,
      from: document.getElementById('fromdate')?.value,
      to: document.getElementById('todate')?.value,
      captchaInput: document.getElementById('txtInput')?.value,
    }));

    if (captchaText.length < 4) {
      console.log('    CAPTCHA was empty/short, retrying...');
      continue;
    }

    await page.fill('#txtInput', captchaText);
    console.log(`    Submitting: bench=${formState.bench} from=${formState.from} to=${formState.to}`);
    await page.click('button[type="submit"]:has-text("Search")', { noWaitAfter: true });

    // Wait for results table OR give up, then capture what the page shows
    const gotResults = await page.waitForSelector('table.table-borderd tbody tr', { timeout: 30000 })
      .then(() => true).catch(() => false);

    if (gotResults) {
      console.log('    Results table appeared.');
      return true;
    }

    // DIAGNOSTIC: capture what the page actually shows after the failed search
    const diag = await page.evaluate(() => {
      const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
      return {
        url: location.href,
        hasTable: !!document.querySelector('table.table-borderd'),
        snippet: bodyText.slice(0, 600),
      };
    }).catch(e => ({ url: 'eval-failed', snippet: e.message }));
    console.log(`    [DIAG] url=${diag.url}`);
    console.log(`    [DIAG] hasTable=${diag.hasTable}`);
    console.log(`    [DIAG] pageText="${diag.snippet}"`);

    console.log('    No results table after search, retrying...');
    await page.waitForTimeout(3000);
  }
  console.log('  All search attempts failed.');
  return false;
}

async function scrapeCurrentPageRows(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table.table-borderd tbody tr'));
    return rows.map((row, idx) => {
      const cells = row.querySelectorAll('td');
      const link = row.querySelector('a');
      return {
        rowIndex:    idx,
        filingNo:    cells[1]?.textContent.trim(),
        caseNo:      cells[2]?.textContent.trim(),
        parties:     cells[3]?.textContent.trim(),
        listingDate: cells[4]?.textContent.trim(),
        status:      link?.textContent.trim(),
      };
    });
  });
}

async function readOrderFromTab(tab) {
  const bodyText = await tab.locator('body').innerText().catch(() => '');
  if (bodyText.includes('Unauthorized access') || bodyText.includes('session expired')) {
    return { blocked: true };
  }
  const toggle = tab.locator('button:has-text("Listing History (Orders)")');
  if (await toggle.count()) { await toggle.first().click().catch(() => {}); await tab.waitForTimeout(700); }
  return tab.evaluate(() => {
    const panel = document.querySelector('#collapseTwo');
    const r = panel?.querySelector('table tbody tr');
    if (!r) return { dateOfListing: null, pdfUrl: null };
    const cells = r.querySelectorAll('td');
    const link = r.querySelector('a');
    return {
      dateOfListing: cells[1]?.textContent.trim() || null,
      pdfUrl: link ? new URL(link.getAttribute('href'), location.href).href : null,
    };
  });
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: process.env.GOOGLE_CREDENTIALS
      ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
      : undefined,
    keyFile: process.env.GOOGLE_CREDENTIALS ? undefined : 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

const HEADERS = ['Bench', 'Filing No', 'Case No', 'Parties', 'Status',
                 'Listing Date', 'Latest Order Date', 'PDF Link', 'Last Checked'];

async function readExisting(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:I100000`,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW', requestBody: { values: [HEADERS] },
    });
    return new Map();
  }
  const map = new Map();
  rows.slice(1).forEach((r, i) => {
    if (r[1]) map.set(r[1], { rowNumber: i + 2, listingDate: r[5] || '' });
  });
  return map;
}

async function appendCase(sheets, existingMap, benchLabel, c) {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const row = [benchLabel, c.filingNo, c.caseNo, c.parties, c.status,
               c.listingDate || '', c.latestOrderDate || '', c.latestOrderPdf || '', now];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  existingMap.set(c.filingNo, { rowNumber: -1, listingDate: c.listingDate || '' });
}

async function updateCase(sheets, rowNumber, benchLabel, c) {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const row = [benchLabel, c.filingNo, c.caseNo, c.parties, c.status,
               c.listingDate || '', c.latestOrderDate || '', c.latestOrderPdf || '', now];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowNumber}:I${rowNumber}`,
    valueInputOption: 'RAW', requestBody: { values: [row] },
  });
}

function isDisposed(statusText) {
  return (statusText || '').toLowerCase().includes('disposed');
}

// ---- MAIN ----
(async () => {
  const { fromDate, toDate } = getDateRange();
  console.log(`Bench: ${BENCH.label} | ${fromDate} -> ${toDate} (${DATE_WINDOW_DAYS} days) | Disposed only: ${DISPOSED_ONLY}`);
  const startTime = Date.now();

  const sheets = await getSheetsClient();
  const existingMap = await readExisting(sheets);

  const browser = await chromium.launch({ headless: true });
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90000);

  console.log('Searching...');
  const searchOk = await runSearch(page, BENCH.value, fromDate, toDate);

  if (!searchOk || !(await page.locator('table.table-borderd tbody tr').count())) {
    console.log('No cases found for this bench/date range (after retries).');
    await browser.close();
    return;
  }

  let counts = { new: 0, updated: 0, skipped: 0, failed: 0 };
  let pageNum = 1;

  while (true) {
    await page.waitForSelector('table.table-borderd tbody tr', { timeout: 30000 }).catch(() => {});
    let rows = await scrapeCurrentPageRows(page);
    if (DISPOSED_ONLY) rows = rows.filter(r => isDisposed(r.status));

    console.log(`\n--- Page ${pageNum}: ${rows.length} cases to consider ---`);

    for (const c of rows) {
      c.parties = cleanText(c.parties);
      const existing = existingMap.get(c.filingNo);

      if (existing && existing.listingDate === (c.listingDate || '')) {
        counts.skipped++;
        continue;
      }

      const linkLocator = page.locator('table.table-borderd tbody tr a').nth(c.rowIndex);
      try {
        const [tab] = await Promise.all([
          context.waitForEvent('page'),
          linkLocator.click(),
        ]);
        await tab.waitForLoadState('domcontentloaded');
        await tab.waitForTimeout(1200);
        const order = await readOrderFromTab(tab);
        await tab.close();

        if (order.blocked) {
          counts.failed++;
          console.log(`  ${c.caseNo} -> BLOCKED (session)`);
        } else {
          c.latestOrderDate = order.dateOfListing;
          c.latestOrderPdf  = order.pdfUrl;
          if (!existing) {
            await appendCase(sheets, existingMap, BENCH.label, c);
            counts.new++;
            console.log(`  ${c.caseNo} -> ${c.latestOrderDate || 'no order'} (new)`);
          } else {
            await updateCase(sheets, existing.rowNumber, BENCH.label, c);
            existing.listingDate = c.listingDate || '';
            counts.updated++;
            console.log(`  ${c.caseNo} -> ${c.latestOrderDate || 'no order'} (updated)`);
          }
        }
      } catch (err) {
        counts.failed++;
        console.log(`  ${c.caseNo} -> FAILED: ${err.message.split('\n')[0]}`);
      }
      await sleep(DELAY_BETWEEN_CASES_MS);
    }

    const nextLink = page.locator('a:has-text("Next")');
    if (!(await nextLink.count())) break;
    try {
      await nextLink.first().click();
      await page.waitForTimeout(1500);
      await page.waitForSelector('table.table-borderd tbody tr', { timeout: 30000 }).catch(() => {});
    } catch { break; }
    pageNum++;
    if (pageNum > 500) { console.log('Page cap hit.'); break; }
  }

  await browser.close();
  console.log(`\nDone. New: ${counts.new}, Updated: ${counts.updated}, Skipped: ${counts.skipped}, Failed: ${counts.failed}`);
  const mins = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`Total time: ${mins} minutes.`);
})();