# RepoShout

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/joaipdjaiefbenoijcekdnjagiadikkd)](https://chromewebstore.google.com/detail/joaipdjaiefbenoijcekdnjagiadikkd)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Share GitHub repos, issues and PRs to X with a pre-filled post.

**You press Post on X.** RepoShout never posts on your behalf — it only opens X's composer with the text and link already filled in.

日本語版: [README.ja.md](README.ja.md)

![The Share button sitting to the left of Notifications, Fork and Star on a GitHub repository page](store/screenshot-1-repo.png)

---

## What it does

| Where | How to trigger |
|---|---|
| Repository pages | The **Share** button, to the left of Pin / Watch / Fork / Star |
| Issues and pull requests | The **Share** button, to the left of New issue / Code |
| Other shareable GitHub pages | Toolbar icon, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> (<kbd>Option</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> on macOS) |

The toolbar icon and the shortcut work on shareable GitHub pages, including the ones that already show a button. **Sensitive pages — authentication, account, settings and organisation administration — are refused at every entry point**, so pressing the icon or the shortcut there does nothing.

Changed your mind? Press <kbd>Esc</kbd> in the share window to dismiss it.

The post text adapts to the page:

| Page | Generated text |
|---|---|
| Repository | `owner/repo: description` |
| Issue | `Title (Issue #123 · owner/repo)` |
| Pull request | `Title (PR #123 · owner/repo)` — the author suffix is stripped |
| Discussion | `Title (Discussion #123 · owner/repo)` |
| Anything else | Page title |

Example:

```
octocat/Hello-World: My first repository on GitHub!
https://github.com/octocat/Hello-World
```

Authentication, account, settings and organisation-administration pages are not shared at all — the button and the shortcut simply do nothing there, because a page like *Personal access tokens* has a title and a path that have no business in a draft post. Path segments are decoded before that decision is made, so `/%73ettings/tokens` is refused too; a URL that cannot be decoded unambiguously is refused rather than guessed at.

Query strings on the pages that *are* shared are handled per route, and **only values whose set can be enumerated or checked mechanically are kept** — page numbers, open/closed state, sort order and direction, `?plain=1` on a Markdown file, `?diff=split&w=1` on a diff, `quick_pull` on a prepared pull request, the `type` of a GitHub search. **Everything free-text is dropped**: search terms (`q`, `query`, `discussions_q`), a prepared pull request's `title` and `body`, and identifier-shaped values such as `labels`, `author`, `branch`, `path`, `milestone`, `category` and `template` — because no finite list of patterns can prove that arbitrary text carries no secret. Anything not on that route's table is dropped too, which covers `?tab=readme-ov-file`, `notification_referrer_id` and `utm_*`. On authentication, account and settings routes the page is not shared at all, so an OAuth `client_id`/`state` or a token in a URL can never reach a draft post. Line anchors (`#L10-L20`), comment anchors and README section anchors are kept — including long Japanese headings, which percent-encode to well over a hundred characters — because those are the point of sharing. A fragment containing `=` is dropped whatever its name, which covers `#access_token=`, `#client_secret=`, `#api_key=` and anything else of that shape without having to enumerate them; so are fragments with broken percent-encoding, control characters, or more than 512 characters.

The full policy is the `QUERY_RULES` table in [`src/share.js`](src/share.js) — each parameter carries the *type* of value allowed (`int`, `bool` or `enum`) — and every row of it is covered by [`test/fixtures.js`](test/fixtures.js).

## Install

### From the Chrome Web Store

**[Install RepoShout](https://chromewebstore.google.com/detail/joaipdjaiefbenoijcekdnjagiadikkd)** — the recommended route: it updates automatically. The badge above shows the published version.

### From source (unpacked)

Use this to run modified code, or in a Chromium browser without Chrome Web Store access.

1. Download or clone this repository
2. Open `chrome://extensions` (`arc://extensions`, `brave://extensions`, `edge://extensions`)
3. Turn on **Developer mode**
4. Click **Load unpacked** and select this folder

Reload any open GitHub tab afterwards — content scripts are injected at page load.

### Changing the shortcut

`chrome://extensions/shortcuts`.

On Windows, <kbd>Alt</kbd>+<kbd>Shift</kbd> on its own is what Windows uses to cycle keyboard layouts. If you have more than one input language installed and the shortcut feels unreliable, reassign it there — <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> is usually free.

### Language

The button, its tooltip and the toolbar icon follow your browser's language. English and Japanese ship in `_locales/`; any other language falls back to English. Nothing in the interface is hard-coded to one language — a test fails if it is.

## Related work

This is not the first attempt at the idea, and it is worth being straight about that.

[RepoCast](https://chromewebstore.google.com/detail/lpkhpmjlkjgdlnajljaipakcnhgdodfe) (v1.0.5, updated 2026-07-18, 3 users at the time of writing) covers adjacent ground: it adds a button to GitHub repository pages and generates share copy and share cards for X, LinkedIn, Reddit, WhatsApp and Discord through a side panel. Earlier attempts — [chrome-ext-github-tweet-button](https://github.com/joshbuchea/chrome-ext-github-tweet-button) (archived 2018), [gitShare](https://github.com/LukyVj/gitShare) (2015), [chrome-share-on-twitter](https://github.com/robertoentringer/chrome-share-on-twitter) (2021) — are all unmaintained and predate Chrome's Manifest V2 shutdown, so they no longer run.

RepoShout is narrower than RepoCast on purpose (one destination, no side panel, no cards) and differs in three ways that came out of measurement rather than preference:

- **It handles signed-in and signed-out GitHub, which are different implementations.** Signed-out pages use the legacy `ul.pagehead-actions`; signed-in repository pages use a React header keyed on `data-testid="repo-header-actions"`; signed-in issues and pull requests use a third one again, the Primer PageHeader action slot (`data-component="PH_Actions"`). All three anchors are attributes GitHub keeps stable for its own tooling, not hashed CSS-module class names.
- **Character counting is checked against X's own implementation, and is designed to over-count rather than under-count.** The extension ships a small counter of its own — no third-party code in the package — but the test suite runs `twitter-text` 3.1.0 as an oracle over every fixture, over the pinned counting sections of the official conformance corpus, and over a generated adversarial corpus of several thousand strings, and fails if the extension's count is *lower* than X's on any of them. No under-count has been found in that set; it is a finite regression check, not a proof over every possible input or over future X behaviour. Under-counting is the only direction that hurts: it produces a post X refuses. Over-counting only trims a little early. Two earlier versions under-counted in ways nobody noticed until it was measured — half-width katakana as 1, and bare domains as their literal length.
- **Open / Merged / Closed state is deliberately absent from the post text.** The value read for the same pull request differed between signed-in and signed-out pages during testing, so it is omitted rather than risk publishing something false.

## Design

Browser extensions that inject UI into GitHub have a habit of dying when GitHub redesigns — as the abandoned predecessors listed above show. RepoShout is built to limit *how* it breaks rather than to pretend it won't.

- **If the anchor element isn't found, it does nothing.** No error, no fallback DOM surgery, no broken GitHub page.
- **GitHub's existing DOM is read, never modified.** The extension adds one `<style>` element in the document head and one wrapper holding one button — an `<li>` inside the repository page's `<ul>`, a `<div>` inside the flex row on issues and pull requests. It deletes and replaces nothing of GitHub's own.
- **It never inspects which buttons are present.** Signed-in and signed-out GitHub show different button sets; prepending to the container works identically for both, and for whatever GitHub adds next.
- **The toolbar icon and keyboard shortcut don't touch the DOM at all.** They work from the tab's URL and title, so they keep working even if the in-page button stops appearing.
- Colours are read from GitHub's own theme variables (`--button-default-*`), so light and dark mode follow automatically.

## Permissions

RepoShout requests two API permissions.

| Permission | Why |
|---|---|
| `activeTab` | Read the URL and title of the tab you are on. Per Chrome's design it is granted only at the moment you explicitly invoke the extension (toolbar click or keyboard shortcut) and only for that tab. It does not allow background monitoring of browsing. |
| `storage` | Remember which window the extension itself opened, so Esc closes that window and nothing else. Written to `chrome.storage.session`, which lives in memory, is cleared when you quit the browser, is never written to disk, and is not readable by content scripts. |

The `storage` permission was added in 1.1.0. What it holds is a list of window IDs and the time each was opened — no URLs, no page content, no history. **That record** is never sent anywhere.

Content scripts run on two sites:

| Site | Purpose |
|---|---|
| `github.com` | Add the Share button. Reads the page only to find the button row; adds one `<style>` element and one wrapper holding one button, and changes nothing else. |
| `x.com` | **One `keydown` listener; `event.key` is checked on each press and anything other than an unmodified Escape is ignored immediately** — so you can dismiss a share window you didn't want. Field values and page content are never read. |

The X script never reads page content. Before closing a window it asks the service worker one question: *is this window one you opened?* The answer comes from the window ID that `chrome.windows.create()` returned, and from nothing else. A page cannot read or forge that ID.

Until 1.0.1 the script also accepted a window whose `window.name` was a fixed string. That string is written in this public repository, and any page can open a window with the same name, so it was never proof of anything; 1.1.0 removes it. **It cannot close your own X tabs** — and that is now checked by an end-to-end test that opens a window with the old forged name and asserts Esc leaves it alone.

The extension makes no background network requests and contacts no server of its own. It does hand two values to X — the page title and the canonicalised URL travel to X inside the composer link, at the moment the composer opens, before you decide whether to post. That is the feature, not a side effect, but it is worth being explicit about: if a page is confidential, do not press Share on it. The only thing the extension itself stores is the list of window IDs described above, in memory, until you quit the browser. See [PRIVACY.md](PRIVACY.md).

## Layout

```
manifest.json            Manifest V3 definition
src/share.js             Text and URL construction (pure logic, no DOM access)
src/content.js           In-page button injection
src/background.js        Window creation and Esc ownership (service worker)
src/esc-close.js         Escape handling on x.com
icons/                   Icons
test/fixtures.js         Expected values — shared by the Node and browser runners
test/*.test.mjs          Node test suites
test/share.test.html     Browser runner over the same fixtures (manual, optional)
scripts/package.mjs      Deterministic ZIP builder
scripts/package-files.mjs The list of files that ship (the single source of truth)
```

## Tests

Everything runs from a clean checkout:

```bash
npm ci
npm test          # unit + oracle + real-extension E2E
npm run package   # dist/reposhout-<version>.zip and its SHA-256
```

Requirements: Node 22+, Chrome or Chromium (found via `CHROME_PATH` or the usual locations), and `openssl` for the E2E's throwaway certificate. **The extension itself has no runtime dependencies** — `package.json` lists none, and nothing from `node_modules/` is shipped. `npm ci` installs one test-only dev dependency, `twitter-text` 3.1.0, which the counting tests use as an oracle.

| Suite | Command | What it covers |
|---|---|---|
| Unit + oracle | `npm run test:unit` | Hand-written fixtures for the per-route URL policy, refusal of sensitive routes, suffix preservation, title parsing and truncation safety; plus `twitter-text` 3.1.0 as an oracle over a generated differential corpus |
| Official conformance | `npm run test:conformance` | The counting sections of Twitter's own `conformance/validate.yml`, vendored at a pinned upstream commit and checked by SHA-256 |
| Packaging | `npm run test:package` | Builds with each write deliberately failed in turn, and checks that the previous artifact survives, that nothing partial is left, and that a `-dirty` build is named `-dirty` in its manifest too |
| Manifest and package | included above | Manifest V3 validity, the permission list (the test fails if a permission is added), no remote-code patterns, the exact list of shipped files |
| Real-extension E2E | `npm run test:e2e` | 10 tests. Loads exactly the files listed in `scripts/package-files.mjs` into real Chrome via `Extensions.loadUnpacked`, with `x.com` and `github.com` mapped to a local HTTPS server, and drives the real service worker |
| Browser runner | open `test/share.test.html` | The same fixtures, rendered as a table — useful for reading the actual output |

On character counting: across the official corpus and the generated adversarial corpus, **no case was found where the counter falls below X's own**. That is a finite regression check, not a proof over all inputs.

The E2E is the one that matters for the Escape behaviour, because that behaviour is a property of the whole extension rather than of one file:

| Case | Expected |
|---|---|
| A window this extension opened, plain Esc | closes |
| The same, after the service worker has been terminated | **still closes** |
| **A window opened by a page using the old forged name** | **does not close** |
| An X tab you opened yourself | does not close |
| Shift+Esc | does not close |
| After the window is closed, its ID is forgotten | not reusable |

Measured 2026-08-06 on 1.1.4: unit 90 passed / 0 failed, E2E 10 passed / 0 failed. The counts move; `npm test` prints the current ones. Both Escape cases were also run against the 1.0.1 implementations to confirm they fail there — a test that cannot fail proves nothing.

## Verification status

Measured 2026-07-31 – 2026-08-02, against live GitHub in both signed-in and signed-out states.

| Check | Result |
|---|---|
| Button placement, signed out | Leftmost, height matches neighbours exactly, tops aligned |
| Button placement, signed in | Same |
| Button placement, signed-in issues and PRs | Immediately left of New issue / Code; height 31.997px against a 31.997px neighbour, top offset 0.000px |
| Anchor exclusivity | The three containers never co-occur. `PH_Actions` is present only on `/issues`, `/issues/N` and `/pull/N` — not on repository roots, Actions, file views, notifications or settings |
| Dark mode | Background, text and border resolve to the same values as GitHub's own buttons |
| Client-side navigation | Button survives; post text is recomputed at click time |
| Navigation across repositories | Button reappears correctly on the new repository, with the new repository's text |
| Browser back / forward | Button present after both |
| Self-repair if removed | Reinstated within ~1s in a visible tab |
| Double injection | Prevented |

### Fixed after adversarial review

The code was reviewed along four axes (Manifest V3 validity, security, DOM resilience, text logic). Thirty findings were raised; each was independently checked by a separate reviewer trying to refute it. Twenty-six were rejected as non-issues. Three were real and are fixed:

| Severity | Issue | Fix |
|---|---|---|
| major | An emoji landing exactly on the truncation boundary split a surrogate pair, so `encodeURIComponent` threw. Nothing caught it, so **every entry point silently did nothing**. | Truncate by code point; fall back to URL-only sharing if anything throws. 0 failures across 251 boundary positions (the previous implementation failed 25). |
| minor | X's character counter is understood to weight full-width characters as 2 (implemented to match twitter-text's weighted ranges; measured 2026-07-31). Counting plain characters meant Japanese text exceeded 280 from about 129 characters. | Truncate by weighted length. 400 Japanese characters now yield 274/280. |
| minor | `/orgs/{org}/discussions/{n}` was parsed as a repository named `orgs/{org}`, putting a non-existent repository name into the post. | Exclude GitHub's reserved namespaces. |

### Fixed in 1.1.0 after a second review

A second review of the published 1.0.1 raised four findings. Each was reproduced against the shipped code before anything was changed, and each fix is held in place by a test that was checked to fail against the old implementation.

| Severity | Issue | Fix |
|---|---|---|
| major | Every query parameter was stripped, so `/issues?q=is:open label:bug` shared as a bare issue list, `?plain=1` was lost while its `#L14` anchor was kept (an anchor that does nothing without it), and a prepared pull request lost its title and body. The README claimed only tracking parameters were removed. | A per-route allowlist. Meaningful parameters are kept, unknown ones are dropped, and authentication/settings routes lose the query and fragment entirely. |
| major | Character weights were an approximation of twitter-text — default 1 with CJK ranges at 2, the inverse of the real rule. Half-width katakana, arrows, symbols and Latin Extended counted as 1 when X counts them as 2, so a long enough title could produce a post X refuses; a ZWJ family emoji counted as 11 instead of 2, truncating emoji-heavy titles early. | The twitter-text v3 definition: default 2, four weight-1 ranges, emoji per grapheme cluster, URLs as 23, NFC first. |
| major | Esc closed any window whose `window.name` matched a constant published in this repository, and the service worker's record of its own windows lived only in memory — so after Chrome shut the worker down (tens of seconds), Esc silently stopped working on genuine share windows. | Window creation moved into the service worker for all three entry points; ownership is the window ID alone, stored in `chrome.storage.session` so it survives the worker restarting. |
| major | No dependency-free way to run the tests, no CI, and the ZIP was assembled by hand, so the submitted artefact could not be reproduced or checked against the repository. | `npm ci && npm test && npm run package`, a GitHub Actions workflow running the same commands, and a deterministic packager whose output has an identical SHA-256 on every run. |

## Known limitations

- **Narrow windows hide the button**, because GitHub hides its own Fork/Star row at those widths. This is deliberate — fighting GitHub's layout is how extensions break.
- **Pages other than repositories, issues and pull requests have no in-page button** when signed in — Actions runs, file views and notifications have no action row the button belongs in. The toolbar icon and shortcut cover other shareable pages. **Settings, authentication, account and organisation-administration pages are refused at every entry point**, including the toolbar icon and the shortcut, so they are never shared.
- **Free-text query values are never shared.** Search terms (`q`, `query`, `discussions_q`) and prepared pull-request `title` / `body` are dropped from the shared URL. Only values whose set can be enumerated or checked mechanically are kept — page numbers, states, sort orders, booleans. Identifier-shaped values such as `labels`, `author`, `branch` and `path` are dropped too (1.1.8): a token can be typed into any of them. This is deliberate: no finite list of patterns can prove that arbitrary text contains no secret.
- **Pages whose remaining URL looks like it carries a credential are refused outright** — for example a file path such as `.../blob/main/access_token=…`, or a GitHub / `Bearer` / AWS / Slack / JWT / private-key token shape. The whole URL is refused rather than a part of it silently removed, and a short notice says so without showing the URL or the value. The same check runs on the post text, and **on the raw page title before the extension transforms it** (1.1.8): truncating a long title used to shorten a token past the pattern's minimum length, so a fragment reached X. Text is compared both as-is and after invisible characters are removed and the string is normalised (NFKC), so `access_token＝…` in full-width characters, or a token split by a zero-width space, is caught too. **The check covers the patterns listed above; it is not a guarantee that every possible secret is detected.** Merely mentioning the word — a file named `access_token.md` — still shares.
- **Open / Merged / Closed state is not included in the post text.** The value read for the same pull request differed between signed-in and signed-out pages during testing, so it is omitted rather than risk publishing something false.
- `github.com` only. GitHub Enterprise and Gist are out of scope.
- **The extension cannot tell a private repository from a public one by its URL.** It refuses GitHub's authentication and settings pages, but on an ordinary repository page it is your call whether the title and URL should reach X.
- Character counting is not the official `twitter-text` parser at runtime; it is verified against it in the tests. The pinned counting sections of the official `validate.yml` are run; the URL-extraction, autolink and TLD suites are not, and neither is the live behaviour of X itself.
- Behaviour after any future GitHub redesign cannot be verified in advance.

## License

[MIT](LICENSE)

## Trademarks

This extension is not affiliated with, endorsed by, or sponsored by X Corp. or GitHub, Inc.
X and the X logo are trademarks of X Corp. GitHub is a trademark of GitHub, Inc.
