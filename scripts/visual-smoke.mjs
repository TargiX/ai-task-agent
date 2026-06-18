import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5173';
const workspaceKey =
  process.env.SMOKE_WORKSPACE ||
  `visual-smoke-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}-${process.pid}`;
const qaDir = path.join(process.cwd(), 'qa');
await fs.mkdir(qaDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  await seedBrowserWorkspace(desktop);
  await desktop.goto(baseUrl, { waitUntil: 'networkidle' });
  await desktop.getByRole('heading', { name: /Product idea workspace|MVP/i }).first().waitFor();
  await desktop.getByRole('button', { name: /^Reset$/ }).click();
  await desktop.getByRole('button', { name: /Generate PRD and tasks/i }).click();
  await desktop.locator('.nova-task-cell strong').first().waitFor({ timeout: 10_000 });
  await desktop.getByRole('button', { name: /Approve pending/i }).click();
  await desktop.getByRole('button', { name: /Prepare package/i }).click();
  await desktop.getByText('5 issues ready for export').waitFor();
  await desktop.getByRole('button', { name: /^Download$/ }).waitFor();
  await desktop.locator('.nova-export').getByText('Connector verification').waitFor();
  await desktop.locator('.nova-export').getByRole('button', { name: /^Verify$/ }).click();
  await desktop.locator('.nova-export').getByText('GitHub Issues').waitFor();
  await desktop.getByText('Run history').waitFor();
  await desktop.locator('.nova-run-row').first().waitFor();
  await desktop.getByRole('tab', { name: /PRD/i }).click();
  await desktop.getByRole('heading', { name: 'Retrieved context' }).waitFor();
  await desktop.getByText('Customer feedback SaaS domain pattern').waitFor();
  await desktop.getByRole('button', { name: /Settings/i }).click();
  await desktop.getByText('Scope coverage').waitFor();
  await desktop.getByText('CLOUDFLARE_D1_DATABASE_ID').first().waitFor();
  await desktop.getByText('Launch plan').waitFor();
  await desktop.getByText('FREELLMAPI_BASE_URL').waitFor();
  await desktop.locator('.nova-preflight').getByRole('button', { name: /^Verify$/ }).click();
  await desktop.getByText('Storage roundtrip').waitFor();
  await desktop.getByRole('button', { name: /Run report/i }).click();
  await desktop.locator('.nova-demo-report').getByText('Trace export').waitFor();
  await assertNoHorizontalOverflow(desktop, 'desktop');
  const coverageRows = await desktop.locator('.nova-coverage-row').count();
  if (coverageRows < 10) {
    throw new Error(`Expected at least 10 coverage rows, got ${coverageRows}`);
  }
  await desktop.screenshot({ path: path.join(qaDir, 'visual-desktop.png'), fullPage: true });
  await desktop.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  await seedBrowserWorkspace(mobile);
  await mobile.goto(baseUrl, { waitUntil: 'networkidle' });
  await mobile.getByText('Scope coverage').scrollIntoViewIfNeeded();
  await mobile.getByText('Scope coverage').waitFor();
  await assertNoHorizontalOverflow(mobile, 'mobile');
  await mobile.screenshot({ path: path.join(qaDir, 'visual-mobile.png'), fullPage: true });
  await mobile.close();

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl,
        workspace: workspaceKey,
        screenshots: ['qa/visual-desktop.png', 'qa/visual-mobile.png'],
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

async function seedBrowserWorkspace(page) {
  await page.addInitScript(
    ({ workspace, accessToken }) => {
      localStorage.setItem('ai-task-agent.workspaceId', workspace);
      if (accessToken) localStorage.setItem('ai-task-agent.accessToken', accessToken);
    },
    { workspace: workspaceKey, accessToken: process.env.WORKSPACE_ACCESS_TOKEN || '' },
  );
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    doc: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  const scrollWidth = Math.max(overflow.body, overflow.doc);
  if (scrollWidth > overflow.viewport + 8) {
    throw new Error(`${label} horizontal overflow: ${scrollWidth}px > ${overflow.viewport}px`);
  }
}
