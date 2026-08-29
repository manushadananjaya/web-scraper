import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();

await page.goto('http://localhost:3319/edit-form-preview');
await page.click('text=Edit content');
await page.waitForTimeout(200);
await page.click('text=Save changes');
await page.waitForTimeout(500);
const errorText = await page.locator('.text-red-700').textContent().catch(() => null);
console.log('error surfaced:', errorText);
