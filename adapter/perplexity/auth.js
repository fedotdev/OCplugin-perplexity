// adapter/perplexity/auth.js
// opencli perplexity auth -- quick check that the current Chrome profile
// is signed in to Perplexity.

import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { PERPLEXITY_DOMAIN } from './utils.js';
import { ensurePerplexityPage, isOnLoginWall, getPageUrl } from './utils.js';

export default cli({
  site: 'perplexity',
  name: 'auth',
  description: 'Check whether the current Chrome profile is signed in to Perplexity',
  access: 'read',
  domain: PERPLEXITY_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [],
  func: async (page) => {
    await ensurePerplexityPage(page, { newChat: false });
    const onWall = await isOnLoginWall(page);
    return {
      ok: !onWall,
      signed_in: !onWall,
      url: await getPageUrl(page),
      error_code: onWall ? 'AUTH_REQUIRED' : null,
      error_message: onWall ? 'Perplexity is showing a login wall' : null,
    };
  },
});
