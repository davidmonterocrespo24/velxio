/**
 * Public barrel for the marketplace discovery + REST client.
 *
 * Consumers (UI, plugin loader wiring, etc.) should import only from
 * here — the file split inside `src/marketplace/` may change.
 */

export {
  MarketplaceClient,
  MarketplaceAuthRequiredError,
  MarketplaceUnavailableError,
  type MarketplaceClientOptions,
} from './MarketplaceClient';

export { getDiscoveryUrl, getMarketplaceBaseUrl } from './config';

export {
  MARKETPLACE_DISCOVERY_SCHEMA_VERSION,
  type InstalledRecord,
  type LicenseDenylist,
  type LicenseRecord,
  type MarketplaceDiscoveryDocument,
  type MarketplaceStatus,
  type MarketplaceUnavailableReason,
} from './types';
