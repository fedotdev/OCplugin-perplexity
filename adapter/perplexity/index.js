// adapter/perplexity/index.js
// Aggregates all perplexity site commands for opencli discovery.

import ask from './ask.js';
import auth from './auth.js';
import inspect from './inspect.js';
import newThread from './new.js';
import status from './status.js';

export { ask, auth, inspect, newThread, status };
export default [ask, auth, inspect, newThread, status];
