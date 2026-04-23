// @vitest-environment jsdom
/**
 * Tests for the build-time env-var resolution. The runtime env is
 * passed in as a parameter so jsdom doesn't need to inject anything.
 */
import { describe, expect, it } from 'vitest';

import { getDiscoveryUrl, getMarketplaceBaseUrl } from '../marketplace/config';

describe('marketplace config', () => {
  it('returns default when env var is missing', () => {
    expect(getMarketplaceBaseUrl({})).toBe('https://api.velxio.dev');
  });

  it('returns null when env var is empty string (explicit opt-out)', () => {
    expect(getMarketplaceBaseUrl({ VITE_VELXIO_MARKETPLACE_BASE_URL: '' })).toBeNull();
  });

  it('returns null when env var is whitespace only', () => {
    expect(getMarketplaceBaseUrl({ VITE_VELXIO_MARKETPLACE_BASE_URL: '   ' })).toBeNull();
  });

  it('uses the configured value when set', () => {
    expect(
      getMarketplaceBaseUrl({ VITE_VELXIO_MARKETPLACE_BASE_URL: 'https://staging.api.velxio.dev' }),
    ).toBe('https://staging.api.velxio.dev');
  });

  it('strips trailing slashes so url joining is unambiguous', () => {
    expect(
      getMarketplaceBaseUrl({ VITE_VELXIO_MARKETPLACE_BASE_URL: 'https://api.velxio.dev///' }),
    ).toBe('https://api.velxio.dev');
  });

  it('builds the discovery URL when configured', () => {
    expect(getDiscoveryUrl({ VITE_VELXIO_MARKETPLACE_BASE_URL: 'https://api.example.com' })).toBe(
      'https://api.example.com/.well-known/velxio-marketplace.json',
    );
  });

  it('returns null discovery URL when disabled', () => {
    expect(getDiscoveryUrl({ VITE_VELXIO_MARKETPLACE_BASE_URL: '' })).toBeNull();
  });
});
