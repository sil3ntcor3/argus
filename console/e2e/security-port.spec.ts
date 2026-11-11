import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// The regular e2e suite must not bootstrap accounts on its shared fixture stack.
test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'Run through task console:e2e:security against a disposable stack.',
);

const apiURL = process.env.E2E_API_URL || 'http://127.0.0.1:56276';
// Synthetic credentials for this disposable stack; no production fixture data.
const admin = {
  email: 'security-port-admin@example.test',
  password: 'ArgusSecuritySmoke123!',
};
const member = {
  name: 'Argus Security Smoke User',
  email: `security-port-user-${randomUUID()}@example.test`,
  password: 'ArgusMemberSmoke123!',
};

async function login(page: Page, email: string, password: string) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.beforeAll(async ({ request }, testInfo) => {
  test.skip(testInfo.config.metadata.securityPort !== true, 'Use the isolated security-port configuration.');
  // Fresh installs use the real bootstrap endpoint. A rerun may reuse the same
  // synthetic admin; its credentials are still proven through the login UI.
  const response = await request.post(`${apiURL}/api/admin/init`, { data: admin });
  expect([201, 403]).toContain(response.status());
});

test('preserves bootstrap, admin-created login and session reload', async (
  { page, browser, baseURL },
  testInfo,
) => {
  const runtimeErrors: string[] = [];
  const consoleErrors: string[] = [];
  const observe = (target: Page) => {
    target.on('pageerror', (error) => runtimeErrors.push(error.message));
    target.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
  };
  observe(page);
  let memberContext: BrowserContext | undefined;

  try {
    await page.goto('/login?redirect=/admin/users');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await login(page, admin.email, admin.password);
    await expect(page).toHaveURL(/\/admin\/users\/?$/);
    await expect(page).toHaveTitle(/Users \| Argus/);
    await expect(page.getByRole('cell', { name: admin.email, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await expect(page.locator('#boot-splash')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('admin-session-desktop.png') });

    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add User', exact: true });
    await dialog.getByLabel('Name', { exact: true }).fill(member.name);
    await dialog.getByLabel('Email', { exact: true }).fill(member.email);
    await dialog.getByLabel('Password', { exact: true }).fill(member.password);
    const creationResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/auth/admin/create-user') &&
        response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Create User', exact: true }).click();
    expect((await creationResponse).status()).toBe(200);
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('cell', { name: member.email, exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('admin-created-user-desktop.png') });

    memberContext = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
    });
    const memberPage = await memberContext.newPage();
    observe(memberPage);
    // A new member has no workspace; exercise its creation entry point directly.
    await memberPage.goto('/login?redirect=/workspaces/create');
    await login(memberPage, member.email, member.password);
    await expect(memberPage).toHaveURL(/\/workspaces\/create$/);
    await expect(memberPage.getByText('Create a new workspace', { exact: true })).toBeVisible();
    await memberPage.reload();
    await expect(memberPage.getByText('Create a new workspace', { exact: true })).toBeVisible();
    // Exercise the browser's cookie rules, including Secure cookies on loopback.
    const session = await memberPage.evaluate(async () => {
      const response = await fetch('/api/auth/get-session', {
        credentials: 'include',
      });
      const body = (await response.json()) as { user?: { email?: string } } | null;
      return { status: response.status, email: body?.user?.email ?? null };
    });
    expect(session.status).toBe(200);
    expect(session.email).toBe(member.email);
    await expect(memberPage.locator('vite-error-overlay')).toHaveCount(0);
    await expect(memberPage.locator('#boot-splash')).toHaveCount(0);
    await memberPage.screenshot({ path: testInfo.outputPath('member-session-mobile.png') });
    expect(runtimeErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await testInfo.attach('browser-errors', {
      body: JSON.stringify({ runtimeErrors, consoleErrors }, null, 2),
      contentType: 'application/json',
    });
    await memberContext?.close();
  }
});

test('rejects anonymous HTTP signup without issuing a session cookie', async ({ request }) => {
  const response = await request.post(`${apiURL}/api/auth/sign-up/email`, {
    data: {
      name: 'Argus Public Signup Probe',
      email: `security-port-public-${randomUUID()}@example.test`,
      password: 'ArgusPublicProbe123!',
    },
  });
  expect(response.status()).toBe(404);
  expect(response.headers()['set-cookie']).toBeUndefined();
});
