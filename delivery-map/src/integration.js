// Browser entry for the main Beluchis app: uses the global Leaflet already
// loaded by the pages, plus the geocoder UMD script, and exposes one small API.
import { createAddressWizard } from './addressWizard.js';
import { createMasterMap } from './masterMap.js';

window.BeluchisDelivery = { createAddressWizard, createMasterMap };
