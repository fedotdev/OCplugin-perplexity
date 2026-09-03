// adapter/perplexity/status.js
// opencli perplexity status -- report current Perplexity page state.

import { cli, Strategy } from '@jackwener/opencli/registry';
import { PERPLEXITY_DOMAIN } from './utils.js';
import { isOnLoginWall, getPageUrl } from './utils.js';

export default cli({
  site: 'perplexity',
  name: 'status',
  description: 'Report the current Perplexity page URL and login state',
  access: 'read',
  domain: PERPLEXITY_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [],
  func: async (page) => {
    const url = await getPageUrl(page);
    let onWall = false;
    try { onWall = await isOnLoginWall(page); } catch {}
    return { ok: true, url, signed_in: !onWall, on_login_wall: onWall };
  },
});
