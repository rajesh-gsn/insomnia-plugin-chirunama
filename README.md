# chirunama

Insomnia plugin that previews PNG, PDF, and ZPL label responses. Multiple labels in one response can be stepped through with the arrow buttons or the left and right arrow keys. ZPL is rendered by [Labelary](https://labelary.com).

The package name is `insomnia-plugin-chirunama`. Insomnia shows it as **chirunama**, and the request action is **Preview Label**.

## Use it

1. Send the request.
2. Open **Preview Label** from the request actions (barcode icon).
3. When the response contains more than one label, use **←** and **→** or the arrow keys. The download button follows the label on screen.

A response is kept only for the request that produced it. Sending that request again replaces the stored preview. A response that is not a label clears the previous preview.

Responses larger than 10 MB are not cached.

## Install for local development

This repository is the source. Insomnia loads it through a symlink:

```text
~/Library/Application Support/Insomnia/plugins/insomnia-plugin-chirunama
  -> ~/Documents/GitHub/insomnia-plugin-chirunama
```

After a code change, reload plugins in Insomnia or restart the app, then send the request again before opening the preview. Theme changes are read when **Preview Label** is opened, so a theme switch does not require sending the request again.

## Publish to npm

Insomnia installs the plugin from the npm package `insomnia-plugin-chirunama`. Publishing happens from a GitHub release. `npm publish` runs `scripts/prepare-publish.js` first and refuses a private package, a bad name, or a missing `main.js`.

1. Create an npm access token with permission to publish this package.
2. In the GitHub repository, add that token as the Actions secret `NPM_TOKEN`.
3. Bump `version` in `package.json` to the release you want. npm will not replace a version that already exists.
4. Commit that version, push `main`, then publish a GitHub release whose tag matches it, for example `v0.1.0`.

The workflow `.github/workflows/publish.yml` publishes that commit to the public npm registry. After it succeeds, install it in Insomnia from **Settings → Plugins** with the name `insomnia-plugin-chirunama`.

To publish from this machine instead of GitHub Actions:

```bash
npm login
npm publish
```

## Architecture

The plugin is one file, `main.js`. Insomnia runs it in a sandbox, so the response hook and the preview window cannot see each other. Plugin storage is the bridge.

```text
response arrives
    -> responseHooks reads the body
    -> detect PNG, PDF, or ZPL (including values nested in JSON)
    -> store preview:<requestId>

Preview Label
    -> requestActions reads that store entry
    -> read the selected Insomnia theme from settings
    -> build a self-contained HTML page
    -> open it in a new window
```

### Response hook

`responseHooks` runs after each response.

- It reads the body with `context.response.getBody()` and the `content-type` header.
- It skips bodies above the encoded size guard, about 10 MB plus base64 overhead.
- It stores `{ items: [{ format, body }] }`. `body` is base64. `format` is `png`, `pdf`, or `zpl`.
- The key is `preview:<request id>`. One request keeps one preview.

### Finding labels

`getPreviewData` accepts the raw body or a JSON document.

| Shape | What is extracted |
| --- | --- |
| PNG bytes, or `image/png` | One PNG |
| PDF bytes (`%PDF-` in the first 1024 bytes), or `application/pdf` | One PDF |
| Text with `^XA` and `^XZ`, or a content type containing `zpl` | One or more ZPL labels |
| `data:<type>;base64,...` or a base64 string | Decoded, then detected again |
| JSON object, array, or string | Every nested string, depth-first, in source order |

Base64 is accepted only when it round-trips to the same canonical text, so ordinary response text is not treated as an image.

A ZPL document with two or more `^XA` … `^XZ` blocks becomes one preview item per block. A `^PW` or `^LL` that appears before the first block is copied onto any block that does not set its own size. The walk stops at 100,000 JSON nodes or 10 MB of decoded label bytes, whichever comes first.

### Preview window

`requestActions` does not receive the response body. It loads the stored items, checks that each format and body are valid, and builds an HTML document in a blob URL.

The page is opened with `window.open`. `noopener` is set, so the page cannot read Insomnia’s DOM. Everything the page needs is embedded before it opens:

- PNG and PDF items are data URLs.
- Each ZPL item is a Labelary URL. The page fetches that URL when the label is shown and caches the PNG for later visits.
- The heading is always **Label Preview**.

Labelary is called at 8 dots per mm (203.2 dpi):

```text
https://api.labelary.com/v1/printers/8dpmm/labels/{width}x{height}/0/?{zpl}
```

Width and height come from `^PW` and `^LL`, converted from dots to inches and capped at 30. Missing or invalid sizes fall back to 4×6 inches. Each split label is requested at index `0` because it is already a single label.

Arrow buttons are rendered only when there is more than one item. The first and last positions disable the matching button.

### Theme

The preview is a separate document, and the plugin action does not run inside Insomnia’s themed window. Computed CSS variables from that window are not available.

**Preview Label** calls `context.util.models.settings.get()` and maps the active built-in theme name to the same color variables Insomnia uses (`--color-bg`, `--color-font`, `--color-surprise`, highlight steps, and the rest). `autoDetectColorScheme` selects `lightTheme` or `darkTheme` when `matchMedia` is available; otherwise the explicit `theme` setting is used. Interface font size comes from `fontSize`.

The label image and PDF page stay on a white surface so the artwork remains readable on a dark theme.

Built-in theme names live in `BUILTIN_THEMES` in `main.js`. A custom theme that is not in that map is not applied.

## Limits

- 10 MB decoded preview total per response.
- ZPL rendering needs network access to Labelary from the preview window.
- Only one preview is stored per request.
- Custom Insomnia themes are not copied. The built-in themes shipped with Insomnia are.

## Project layout

```text
package.json                         plugin name, version, and npm publish settings
main.js                              detection, storage, theme lookup, and preview page
scripts/prepare-publish.js           checks the package before npm publish
.github/workflows/publish.yml        publishes to npm when a GitHub release is published
README.md                            this document
```
