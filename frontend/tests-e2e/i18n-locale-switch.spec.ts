import { expect, test } from '@playwright/test';

const LOCALE_STORAGE_KEY = 'velxio.locale';

test.describe('i18n — editor locale picker round-trip (SDK-005c part B)', () => {
  test('localStorage preset boots the editor in Spanish', async ({ page }) => {
    await page.addInitScript(
      ({ key, value }) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          /* private mode — bootEditorLocale falls through to navigator.language */
        }
      },
      { key: LOCALE_STORAGE_KEY, value: 'es' },
    );

    await page.goto('/editor');

    const installedPluginsButton = page.getByRole('button', { name: 'Plugins instalados' });
    await expect(installedPluginsButton).toBeVisible();

    await installedPluginsButton.click();

    const dialog = page.getByRole('dialog', { name: 'Plugins instalados' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Plugins instalados' })).toBeVisible();

    await expect(dialog.getByText('Marketplace')).toBeVisible();
  });

  test('default locale renders the editor in English (no preset)', async ({ page }) => {
    await page.addInitScript(({ key }) => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }, { key: LOCALE_STORAGE_KEY });

    await page.goto('/editor');

    await expect(
      page.getByRole('button', { name: 'Installed plugins' }),
    ).toBeVisible();
  });

  test('runtime picker change re-renders the shell into Spanish', async ({ page }) => {
    await page.goto('/editor');
    await page.evaluate((key) => window.localStorage.removeItem(key), LOCALE_STORAGE_KEY);
    await page.reload();

    await page.getByRole('button', { name: 'Installed plugins' }).click();

    const picker = page.getByTestId('editor-locale-picker');
    await picker.selectOption('es');

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Plugins instalados' })).toBeVisible();

    const stored = await page.evaluate((key) => window.localStorage.getItem(key), LOCALE_STORAGE_KEY);
    expect(stored).toBe('es');
  });
});
