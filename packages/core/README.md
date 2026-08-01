# @platercms/core

The browser half of [Plater](https://github.com/zachphillips/plater): a
framework-free in-browser CMS editor. It renders `content/site.json` into the
page through `data-bind` attributes, turns bound elements into inline
`contenteditable` fields behind `?edit`, gates editing on Google SSO or a shared
edit token, and saves through `/api/save` — where every save is a real git
commit.

Zero dependencies. No build step. One ES module.

```js
import { initPlater } from '@platercms/core';

const plater = initPlater({ brand: 'Northline' });
```

Most sites don't install it: `npm create platercms` and `platercms init` vendor
this file into the site as `plater-core.js`, so the site owns its copy and has
no `node_modules`. Installing the package is for bundled apps that want it
resolved instead of copied.

Pairs with [`@platercms/server-node`](https://www.npmjs.com/package/@platercms/server-node)
(the `api/` handlers) and [`@platercms/capture`](https://www.npmjs.com/package/@platercms/capture)
(click-to-note agent routing).

Full documentation: <https://github.com/zachphillips/plater#readme>

MIT © Zach Phillips
