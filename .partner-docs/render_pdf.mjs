import { chromium } from '@playwright/test';
import path from 'node:path';

const DOCS = '/workspace/project/.partner-docs';
const browser = await chromium.launch();

for (const [html, pdf] of [
  ['dossier.html', 'WASIT-BUSINESS-GLOBAL-PARTNERSHIP-DOSSIER.pdf'],
  ['presentation.html', 'WASIT-BUSINESS-GLOBAL-PARTNER-PRESENTATION.pdf'],
]) {
  const page = await browser.newPage();
  await page.goto('file://' + path.join(DOCS, html), { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.pdf({
    path: path.join(DOCS, pdf),
    format: 'A4',
    printBackground: true,
    margin: { top: '16mm', bottom: '14mm', left: '14mm', right: '14mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;font-size:8px;color:#94a3b8;text-align:center;font-family:sans-serif;">' +
      'WASIT BUSINESS GLOBAL — <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  });
  console.log('pdf', pdf);
  await page.close();
}

await browser.close();
console.log('done');
