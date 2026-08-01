# RepoShout

Share GitHub repos, issues and PRs to X with a pre-filled post.

**You press Post on X.** RepoShout never posts on your behalf — it only opens X's composer with the text and link already filled in.

日本語版: [README.ja.md](README.ja.md)

![The Share button sitting to the left of Notifications, Fork and Star on a GitHub repository page](store/screenshot-1-repo.png)

---

## What it does

| Where | How to trigger |
|---|---|
| Repository pages | The **Share** button, placed to the left of Pin / Watch / Fork / Star |
| Issues, PRs, anywhere else on GitHub | Toolbar icon, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> (<kbd>Option</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> on macOS) |

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

Tracking parameters that GitHub appends (such as `?tab=readme-ov-file`) are removed. Line anchors (`#L10-L20`) and comment anchors are kept, because those are usually the point of sharing.

## Install

### From the Chrome Web Store

**Submitted for review on 2026-08-01. Not published yet.** A link will replace this paragraph once the review completes. Until then, use the unpacked install below — it is the same code as the submitted package.

### From source (unpacked)

1. Download or clone this repository
2. Open `chrome://extensions` (`arc://extensions`, `brave://extensions`, `edge://extensions`)
3. Turn on **Developer mode**
4. Click **Load unpacked** and select this folder

Reload any open GitHub tab afterwards — content scripts are injected at page load.

### Changing the shortcut

`chrome://extensions/shortcuts`.

## Related work

This is not the first attempt at the idea, and it is worth being straight about that.

[RepoCast](https://chromewebstore.google.com/detail/lpkhpmjlkjgdlnajljaipakcnhgdodfe) (v1.0.5, updated 2026-07-18, 3 users at the time of writing) covers adjacent ground: it adds a button to GitHub repository pages and generates share copy and share cards for X, LinkedIn, Reddit, WhatsApp and Discord through a side panel. Earlier attempts — [chrome-ext-github-tweet-button](https://github.com/joshbuchea/chrome-ext-github-tweet-button) (archived 2018), [gitShare](https://github.com/LukyVj/gitShare) (2015), [chrome-share-on-twitter](https://github.com/robertoentringer/chrome-share-on-twitter) (2021) — are all unmaintained and predate Chrome's Manifest V2 shutdown, so they no longer run.

RepoShout is narrower than RepoCast on purpose (one destination, no side panel, no cards) and differs in three ways that came out of measurement rather than preference:

- **It handles signed-in and signed-out GitHub, which are different implementations.** Signed-out pages use the legacy `ul.pagehead-actions`; signed-in repository pages use a React header keyed on `data-testid="repo-header-actions"`. Signed-in Issue and PR pages have no button row at all — which is precisely why the toolbar icon and keyboard shortcut exist rather than being an afterthought.
- **104 automated tests cover the text generation**, including 71 that sweep an emoji across every possible truncation boundary (a bug that otherwise makes every entry point silently do nothing) and weighted character counting for CJK text.
- **Open / Merged / Closed state is deliberately absent from the post text.** The value read for the same pull request differed between signed-in and signed-out pages during testing, so it is omitted rather than risk publishing something false.

## Design

Browser extensions that inject UI into GitHub have a habit of dying when GitHub redesigns — as the abandoned predecessors listed above show. RepoShout is built to limit *how* it breaks rather than to pretend it won't.

- **If the anchor element isn't found, it does nothing.** No error, no fallback DOM surgery, no broken GitHub page.
- **GitHub's existing DOM is read, never modified.** The extension adds exactly one `<li>` and removes nothing.
- **It never inspects which buttons are present.** Signed-in and signed-out GitHub show different button sets; prepending to the container works identically for both, and for whatever GitHub adds next.
- **The toolbar icon and keyboard shortcut don't touch the DOM at all.** They work from the tab's URL and title, so they keep working even if the in-page button stops appearing.
- Colours are read from GitHub's own theme variables (`--button-default-*`), so light and dark mode follow automatically.

## Permissions

RepoShout requests one API permission: **`activeTab`**. Per Chrome's design this is granted only at the moment you explicitly invoke the extension (toolbar click or keyboard shortcut) and only for the current tab. It does not allow background monitoring of browsing.

Content scripts run on two sites:

| Site | Purpose |
|---|---|
| `github.com` | Add the Share button. Reads the page only to find the button row; adds one `<li>`, changes nothing else. |
| `x.com` | **Listen for the Escape key, nothing else** — so you can dismiss a share window you didn't want. |

The X script never reads page content. Before closing a window it verifies identity two ways: the window name assigned at open time, or a windowId the service worker recorded. If neither matches — true for every X tab you opened yourself — it does nothing. **It cannot close your own X tabs.**

The extension makes no network requests of its own and stores nothing. See [PRIVACY.md](PRIVACY.md).

## Layout

```
manifest.json          Manifest V3 definition
src/share.js           Text and URL construction (pure logic, no DOM access)
src/content.js         In-page button injection
src/background.js      Toolbar icon and keyboard shortcut entry point
test/share.test.html   Tests for share.js — open in a browser to run
icons/                 Icons
```

## Tests

**Text generation** — open `test/share.test.html` in a browser. **104 cases, all passing** as of 2026-08-01. Coverage includes 71 cases that sweep an emoji across every possible truncation boundary, weighted character counting for CJK text, and GitHub's reserved namespaces.

**Escape-to-close safety** — `node test/esc-close.test.js` (needs Node 22+ and Chrome). Launches headless Chrome, injects the real `src/esc-close.js`, and asserts three properties:

| Case | Expected |
|---|---|
| A window this extension opened, plain Esc | closes |
| **A window it did not open, plain Esc** | **does not close** |
| A window it opened, Shift+Esc | does not close |

All three pass. Case B is the one that matters: it is why the script identifies windows rather than guessing from the URL.

## Verification status

Measured 2026-07-31 – 2026-08-01, against live GitHub in both signed-in and signed-out states.

| Check | Result |
|---|---|
| Button placement, signed out | Leftmost, height matches neighbours exactly, tops aligned |
| Button placement, signed in | Same |
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

## Known limitations

- **On signed-in Issue and PR pages there is no in-page button.** As of 2026-07-31, GitHub's newer signed-in UI for those pages has no Fork/Star button row to attach to. Use the toolbar icon or the shortcut. Signed-out pages still show the button.
- **Narrow windows hide the button**, because GitHub hides its own Fork/Star row at those widths. This is deliberate — fighting GitHub's layout is how extensions break.
- **Open / Merged / Closed state is not included in the post text.** The value read for the same pull request differed between signed-in and signed-out pages during testing, so it is omitted rather than risk publishing something false.
- `github.com` only. GitHub Enterprise and Gist are out of scope.
- Behaviour after any future GitHub redesign cannot be verified in advance.

## License

[MIT](LICENSE)

## Trademarks

This extension is not affiliated with, endorsed by, or sponsored by X Corp. or GitHub, Inc.
X and the X logo are trademarks of X Corp. GitHub is a trademark of GitHub, Inc.
