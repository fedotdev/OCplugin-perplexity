// adapter/perplexity/new.js
// opencli perplexity new -- open a fresh thread on perplexity.ai.

import { cli, Strategy } from '@jackwener/opencli/registry';
import { PERPLEXITY_DOMAIN } from './utils.js';
import { ensurePerplexityPage, getPageUrl } from './utils.js';

export default cli({
  site: 'perplexity',
  name: 'new',
  description: 'Start a new Perplexity thread in the current tab',
  access: 'write',
  domain: PERPLEXITY_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [],
  func: async (page) => {
    await ensurePerplexityPage(page, { newChat: true });
    return { ok: true, thread_url: await getPageUrl(page) };
  },
});
