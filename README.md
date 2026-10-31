# Bei Cin Lah

Split restaurant bills with friends. The payer adds a receipt and a DuitNow QR, friends open a link, type their
name (no account, no password), tick what they ate, and see exactly what they owe with service charge and SST
included. They pay by DuitNow, upload the slip, and the payer confirms.

## Put it online with Netlify

You need a free GitHub account and a free Netlify account. About 10 minutes.

1. **Upload the code to GitHub.** On https://github.com click New repository, name it `bei-cin-lah`, then
   "uploading an existing file" and drag in everything from this folder (keep the `public`, `lib` and
   `netlify` folders as they are). Click Commit.
2. **Connect Netlify.** On https://app.netlify.com choose Add new site > Import an existing project > GitHub,
   and pick the repository. Netlify reads `netlify.toml`, so leave the build settings as they are and click Deploy.
3. **Open your site.** Netlify gives you an address like `https://something.netlify.app`. Open it, tap New bill,
   and send the bill link to your friends. You can change the address under Site configuration > Domain management.
4. **Receipt reading is free and already on.** When the payer chooses a receipt photo, the phone reads it
   (Tesseract.js, no account or key) and fills in the item names, quantities, prices, service charge, SST and
   rounding. It works best on a flat, well-lit, straight photo; always check the items before creating the bill.
   The first scan on a phone downloads about 8 MB once; later scans are instant and work offline.
   Optional: for messier receipts, add an `ANTHROPIC_API_KEY` in Netlify (Site configuration > Environment
   variables) and redeploy. Claude then reads receipts first (a few sen per scan) and the phone takes over if it fails.

Bills are stored in Netlify Blobs, which Netlify provides with your site. Nothing else to set up.

**First check after deploying:** create a bill on your phone, then open its link on a second phone or a private
browser window, join with another name and tick a dish. If that works, everything is connected.

Netlify's free plan should be enough for friends and family, but check Netlify's current limits for functions
and storage on their pricing page.

## Other ways to run it

- **On your computer:** install Node.js 22.13 or newer, run `npm install` and `node scripts/copy-ocr.js` once
  (for receipt reading), then `node server.js` in this folder and open http://localhost:3000. Bills are saved
  in the `data` folder.
- **A normal server (Render, Railway, Fly.io):** run `node server.js` with Node 22 and keep `DATA_DIR` on a
  persistent disk. `render.yaml` is included for Render, which needs a paid instance for the disk.

## Settings (environment variables)

| Name | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Optional. Reads receipts with Claude first, instead of only on the phone. |
| `ANTHROPIC_MODEL` | Optional. Defaults to `claude-sonnet-5-5`. |
| `DATA_DIR` | Self-hosting only. Folder for the database file. |
| `PORT` | Self-hosting only. Defaults to 3000. |

Claude scans are limited to 15 per hour per visitor to protect your bill. Scans on the phone are free and unlimited.

## How it works

- `lib/core.js`: the whole API, the same code on Netlify and on a normal server.
- `netlify/functions/api.mjs` and `lib/blobs-store.js`: the Netlify side, storing bills in Netlify Blobs.
- `server.js`: the self-hosted side, storing bills in a SQLite file.
- `public/split.js`: the split maths, shared by server and browser. Amounts are whole sen so shares always add
  up to the receipt total.
- `public/receipt-parse.js`: turns the text read off a receipt photo into items and charges.
- `scripts/copy-ocr.js`: copies the on-phone receipt reader into `public/ocr` (Netlify's build step).
- `public/app.js`, `index.html`, `style.css`: the website.
- `node test.js`: checks receipt parsing and the API end to end, including two people ticking dishes at the same moment.

## Things to know

- **Who can do what.** The person who creates a bill is the payer and controls it from that phone. Use
  "Copy my payer link" on the bill to keep a private link that restores control on another phone. Anyone with
  the normal bill link can join and pick dishes. Payment slips are visible only to the payer and the person
  who uploaded them. The QR and receipt photo are visible to anyone with the bill link.
- **Saving and editing.** A new bill being filled in is kept on that phone as you go, so a refresh or a closed
  tab does not lose it; the home page offers to continue or discard it. After creating a bill, the payer can tap
  "Edit items" to change the name, date, dishes or charges. Ticks stay on the dishes that are kept, a removed
  dish comes off whoever ticked it, and payments already confirmed keep their amount.
- **Summary picture.** "Share summary" on a bill makes a picture of who ate what, how much each person owes and
  who has paid, to share in the group chat (phones) or save (computers).
- **Reminders.** "Remind" and "Remind everyone" write a ready message to send on WhatsApp, and people who open
  the bill see a banner if they still owe. Automatic WhatsApp or phone push messages are not built yet. They
  would need a messaging service added to the server.
- **Money.** The app never moves money. People pay in their own banking app and upload the slip.
- **Bill links.** Treat them like a private group link: anyone who has it can join the bill.
