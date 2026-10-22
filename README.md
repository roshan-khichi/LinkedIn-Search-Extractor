# LinkedIn Search Extractor

A Chrome extension (Manifest V3) that turns a LinkedIn **people search** into a clean spreadsheet. Pick the fields you want, choose all pages or a page range, and export to CSV or JSON. It can also check that each profile matches the name in the results, and look up pasted profile links.

Everything runs in your own browser. No server, no account, no data leaves your machine.

> **Use responsibly.** LinkedIn's User Agreement restricts automated data collection. This tool is provided for personal and educational use. You are responsible for how you use it. See [Disclaimer](#disclaimer).

---

## Features

**Search results extraction**
- Choose what to extract: **first name, last name, position, skills, location, profile link**
- **All pages**, or a **page range** (for example pages 3 to 8)
- Moves through pages by clicking LinkedIn's own *Next* button, falling back to loading the page URL
- **Start / Stop / Resume** at any time. Stopping takes effect immediately and keeps what was collected
- Keeps running if you close the popup, with live progress and a badge count on the icon
- Hidden profiles ("LinkedIn Member") are exported as first name `LinkedIn`, last name `Member`, or can be skipped
- Skills are written as one comma-separated cell, for example `Python,SQL,Excel`
- Export as **CSV** (opens cleanly in Excel), **JSON**, or copy to the clipboard

**Verify each profile** (optional)
- Opens every profile in a background tab and compares the first and last name with the search result
- Adds a **Verified** column: `Verified` or `Unverified`
- Replaces member-ID links (`/in/ACoAA…`) with the public link (`/in/laura-northa/`) when available
- Clears the link and marks `Unverified` if the profile is a 404
- Fills in the real name for a hidden "LinkedIn Member" when the profile shows it

**Profile lookup** (separate tab)
- Paste LinkedIn profile links, one per line
- Get **name, company, position, headline, location** and the public profile link
- Add `Full Name` after a link to mark it `Verified` / `Unverified` against that name

**Deep skills scan** (optional, experimental)
- Search results rarely list skills. This opens each profile's Skills page to read them. Slow and sends many extra requests.

---

## Installation

The extension is not on the Chrome Web Store. You install it from source in a few steps.

### 1. Get the code

Either clone the repository:

```bash
git clone https://github.com/roshan-khichi/LinkedIn-Search-Extractor.git
```

or click **Code → Download ZIP** on GitHub and unzip it.

### 2. Load it into Chrome

1. Open `chrome://extensions` in the address bar.
2. Turn on **Developer mode** (top-right switch).
3. Click **Load unpacked**.
4. Select the folder that contains `manifest.json`.
5. Pin the extension: click the puzzle-piece icon in the toolbar, then the pin next to **LinkedIn Search Extractor**.

### GIF


The same steps work in other Chromium browsers (Edge: `edge://extensions`, Brave: `brave://extensions`).

### 3. Updating

Pull or download the new version, then open `chrome://extensions` and click the **reload** icon on the extension card. Refresh any open LinkedIn tabs afterwards.

---

## Usage

### Extract a search

1. Log in to LinkedIn and run a **People** search, with any filters you like. The address should start with `linkedin.com/search/results/people/`.
2. Wait for the results to load, then click the extension icon. The popup should say *People search detected*.
3. Tick the fields you want.
4. Choose **All pages**, or **Page range** and enter from / to.
5. Click **Start extracting**. Keep the LinkedIn tab open. You can close the popup and come back to check progress.
6. When it finishes, click **CSV**, **JSON** or **Copy**.

Use **Stop** to pause, **Resume** to continue from the same page, and **Clear** to delete stored results.

### Options

| Option | What it does |
| --- | --- |
| Skip profiles with hidden names | Leaves out "LinkedIn Member" results |
| Verify each profile | Opens each profile and adds the **Verified** column (see above). Slow. |
| Deep skills scan | Opens each profile's Skills page to fill the Skills column. Slow, experimental. |
| Speed (delay) | Random pause between requests. Default 3 to 6 seconds. Keep it. |

### Look up profiles

1. Open the **Profile lookup** tab.
2. Paste links, one per line. Optionally add the expected name:

   ```
   https://www.linkedin.com/in/jane-doe/
   https://www.linkedin.com/in/john-smith/ | John Smith
   ```
3. Click **Extract profiles**, then export the results.

### Output columns

**Search results**

| Column | Notes |
| --- | --- |
| First Name, Last Name | Credentials and titles after the name are dropped. Hidden names become `LinkedIn` / `Member` |
| Position | The headline shown in the search result |
| Skills | Comma-separated. Filled from "Skills:" snippets, or by Deep skills scan |
| Location | As shown in the result |
| Profile Link | Public link when verification is on and available |
| Verified | Only present when *Verify each profile* was used |

**Profile lookup**: Name, First Name, Last Name, Company, Position, Headline, Location, Profile Link, Expected Name, Verified, Status.

---

## How it works

- `content.js` is injected into the LinkedIn tab and reads the page: result cards, pagination, and profile pages. It does not rely on LinkedIn's obfuscated class names. It looks for stable hooks (search snippet IDs, `/in/` links, list items) and falls back through several strategies.
- `background.js` (service worker) runs the job page by page, so it survives the popup closing. State is saved in `chrome.storage.local`.
- `popup.html / popup.js / popup.css` is the interface, plus CSV / JSON export.

Permissions used: `activeTab`, `scripting`, `storage`, `tabs`, and host access to `https://www.linkedin.com/*`.

### Project structure

```
linkedin-search-extractor/
├── manifest.json     Extension manifest (MV3)
├── background.js     Job runner: paging, stop/resume, verification, profile lookup
├── content.js        Page readers injected into LinkedIn tabs
├── popup.html        Popup markup
├── popup.css         Popup styles
├── popup.js          Popup logic, settings, export
└── icons/            16 / 48 / 128 px icons
```

---

## Troubleshooting

| Problem | What to try |
| --- | --- |
| Popup says **0 results** | Scroll to the top, wait for results to load, reopen the popup. Make sure the URL is a *people* search. |
| Nothing extracts or it stops on a page | Click **Copy diagnostics** at the bottom of the popup and include the text when you open an issue. It contains page structure and the run log, not result text. |
| Red `chrome-extension://invalid/` errors in the browser console | These come from LinkedIn's own scripts checking for extensions. They are not caused by this extension and can be ignored. |
| Names show as "LinkedIn Member" | LinkedIn hides names of people outside your network. Turn on *Verify each profile* to try to resolve them, or skip them. |
| Skills column is empty | Search results rarely include skills. Try *Deep skills scan*. |
| LinkedIn asks you to sign in or verify | Resolve it in the tab, then press **Resume**. |
| Fewer results than expected | LinkedIn serves at most 100 pages per search, and free accounts have a search limit. The popup warns when it sees a limit notice. |
| Extension changes not showing | Reload it on `chrome://extensions` and refresh the LinkedIn tab. |

If LinkedIn changes its markup, the selectors to adjust are at the top of `content.js` (`getCards`, `extractCurrent`, `extractProfile`).

---

## Limitations

- Works on people search results and profile pages only.
- LinkedIn changes its page structure often, so selectors may need updating.
- Profile reading (company, location) is heuristic and may be empty for unusual profile layouts.
- Verify and Profile lookup open one background tab per profile, which can be slow and which LinkedIn may throttle.

---

## Privacy

All processing happens locally in your browser. Extracted data is kept in `chrome.storage.local` until you press **Clear**. The extension makes no network requests of its own and has no analytics or tracking.

---

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by LinkedIn Corporation. LinkedIn's User Agreement restricts scraping and automated access, and accounts that do so can be limited or closed. Use this tool only with your own account, only for data you are allowed to collect and process, and in line with applicable laws (including privacy laws such as GDPR) and LinkedIn's terms. Keep request rates low. The authors accept no liability for how it is used.

---

## Contributing

Issues and pull requests are welcome. When reporting a problem, include the browser version, what you clicked, and the output of **Copy diagnostics**. Remove any personal data first.

## License

Add a license file before publishing (for example MIT) and state it here.
