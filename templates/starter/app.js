// Your site's one script. plater-core.js next to it is vendored by
// `platercms init` / `npm create platercms` — re-sync it with `platercms sync .`
// and never hand-edit it.
import { initPlater } from './plater-core.js';

// Held in a binding because @platercms/capture authenticates with the same
// credential the editor holds (see the commented block below).
const plater = initPlater({ brand: 'Northline' });

// Click-to-note agent routing: uncomment to let an editor click any element,
// leave a sentence, and have a coding agent open the PR. Needs PLATER_AGENT_ENDPOINT
// + PLATER_AGENT_TOKEN on the host and api/agent-note.js deployed.
// import { initCapture } from './plater-capture.js';
// initCapture({ apiBase: '/api', getToken: plater.getToken, brand: 'Northline' });
