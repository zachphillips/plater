# create-platercms

Scaffolds a new site for [Plater](https://github.com/zachphillips/plater), a
git-native in-browser CMS with click-to-note agent routing.

```bash
npm create platercms@latest my-site
cd my-site
npx platercms dev .        # http://127.0.0.1:4188/?edit
```

You get a site that already renders: hand-written HTML, one CSS file, all the
copy in `content/site.json`, plus the vendored client editor and every `api/`
handler. Edit any element in place; Save writes the file (locally) or opens a
real git commit (in production).

Everything is a **vendored copy, not a dependency**. The scaffolded site has no
`package.json` to install, no `node_modules`, and no build step — it is plain
files you own and commit. `npx platercms sync .` re-pulls them when Plater ships
a new version.

```
npm create platercms my-site      scaffold into ./my-site
npm create platercms              scaffold into the current directory
npm create platercms . --force    scaffold alongside existing files (never overwrites)
```

`vercel.json` ships routed for feeds, sitemap, `llms.txt`, and the editable 404,
so pushing to GitHub and importing on Vercel is the whole deploy.

Full documentation: <https://github.com/zachphillips/plater#readme>

MIT © Zach Phillips
