# @platercms/capture

The click-to-note overlay for [Plater](https://github.com/zachphillips/plater).
An authenticated editor clicks any element on the live page, leaves a sentence,
picks an engine and an output (PR by default), and the note is routed to the
Plater agent host through the site's own `/api/agent-note`. A coding agent opens
the pull request.

Zero dependencies. No build step. One ES module.

```js
import { initPlater } from '@platercms/core';
import { initCapture } from '@platercms/capture';

const plater = initPlater({ brand: 'Northline' });
// Capture authenticates with the same credential the editor already holds.
initCapture({ apiBase: '/api', getToken: plater.getToken, brand: 'Northline' });
```

Needs `api/agent-note.js` from
[`@platercms/server-node`](https://www.npmjs.com/package/@platercms/server-node)
deployed, plus `PLATER_AGENT_ENDPOINT` and `PLATER_AGENT_TOKEN` set on the host.
Without them the relay answers 501 and capture stays off.

Most sites don't install it — `npm create platercms` vendors this file as
`plater-capture.js`.

Full documentation: <https://github.com/zachphillips/plater#readme>

MIT © Zach Phillips
