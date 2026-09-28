# Freight Load Board

A truckload bidding site you send carriers to. Carriers see a load's lane, map, dates and specs. Any carrier can bid. Behind the scenes, each bid's MC number is checked against your Highway-approved carrier list, and admin shows who passes. You post loads, compare bids and award carriers from the admin area.

- **Carrier board**: `https://your-site/` shows every open load, with search and filters
- **Load page**: `https://your-site/load/L-XXXXXX` has the map, pickup and delivery, specs, requirements, the current bid and the bid form. This is the link you send.
- **Admin**: `https://your-site/admin` (password protected)

There are no third-party packages. It needs only Node.js 22.13 or newer and uses its built-in SQLite database.

---

## What carriers see

1. They open the load link. They see the lane, route map, miles, dates and windows, equipment, temp, weight, commodity and requirements.
2. **Place bid.** They enter an all-in rate (also shown as $/mile), their MC number and company, plus a contact name, phone or email, and optional notes.
4. They see the current bid, which updates every 30 seconds. They can rebid, and a new bid replaces their earlier one. Bidding closes on its own at the deadline, or when you close or award the load.

## What you can do in admin

- **+ New load**: enter the lane, dates and windows, the bid deadline, equipment and freight details, requirements and notes. You can also add a **private target rate** that carriers never see, and contact info. Miles and the map fill in automatically from the city, state and ZIP.
- **Faster posting**: start a load from a **saved lane**, pick the shipper and receiver from the **address book**, or **paste** a tender email and let the form fill in cities, dates, weight, pallets, equipment, temp, load # and rate. **Save as lane** keeps any load for reuse. A saved lane can **post itself** on a schedule (days, time, pickup offset, bids-due hours). Shipper/receiver names and addresses, customer, customer rate and Aljex Pro # are private.
- **Bulk actions**: tick loads in the list to close bidding, move to draft, set a new bids-due time, or delete.
- **Tracking** (after award): Awarded → Rate con sent (Aljex) → Dispatched → Picked up → Delivered → Invoiced, with dates. Each load has check calls and notes, documents (BOL, POD, signed rate con — up to 12 MB each, stored on the disk), Aljex Pro #, customer rate and margin. Rate confirmations are sent from Aljex, not from this site.
- **Carriers**: everyone who has bid, with lanes, bids, wins, Highway status, contacts and history. Flag carriers **★ Preferred** or **Do not use** and keep private notes. "Do not use" shows in the Bids window and warns you before an award.
- **Counter offers**: in the Bids window, **Counter** emails the carrier a link where they accept or decline. Accepting updates their bid; you get an email either way, then award as usual.
- **Reports**: loads posted and covered, bids per load, revenue, carrier pay and margin, by customer, lane and carrier, for any date range.
- **Import loads (one time)**: upload a CSV or XLSX with many loads at once. Click **Download template** in that window for the column names. Common names also work, such as "Pickup City" or "Ship Date".
- **Bids**: bids are listed low to high, each marked **✓ Pass** or **✗ Not on list** for Highway, with $/mi and each bid's difference from your target. **Award** marks the load as covered and closes bidding. **Reopen for bids** undoes that.
- **Link**: copies the carrier link for a load. **Copy board link** copies the link to the whole board.
- **Edit → Duplicate**: copies a load as a draft, which is useful for repeat lanes. **Status** can be Open, Draft (hidden) or Closed.
- **Export all bids**: downloads a CSV of every bid.
- **Daily email**: the automatic daily list can target only carriers who fit that day's loads (lane history, pickup/delivery state, home state; skips Do not use). A ready-to-send email of every open load with "View & bid" links, plus your carrier email list (collected from bids and any Email column in your Highway sheet). Filter to Highway-pass carriers, copy the addresses into BCC, and remove anyone who opts out.
- **Highway list**: paste your Google Sheet or Excel link, or upload a file. See below.
- **Settings → Email**: bid alerts to you (reply goes to the carrier), carrier bid confirmations, outbid notices, award notices, optional "load covered" notices, and an automatic daily load list (time and days, Denver time). **Send test email** checks the connection. Every email about a load uses the same subject ("Load # · lane") so Outlook keeps it in one conversation.
- **Settings**: company name, tagline, default contact info and the bid terms shown to carriers.

## Hooking up your Highway list

Export or copy your Highway-approved carriers into a Google Sheet or Excel file with a column of MC numbers. The site finds a column headed `MC`, `MC Number`, `MC #` or `Docket` on its own. If your column has a different name, enter it in the admin page. `MC123456`, `MC-123456` and `123456` all match.

**Google Sheets:** Share → General access → **Anyone with the link → Viewer**. Paste the normal sheet link in **Admin → Highway list**. If the list is on a tab other than the first one, open that tab before you copy the link so it includes `#gid=`.

**Excel (OneDrive/SharePoint):** Share → **Anyone with the link can view**, then paste the link. If your IT blocks anonymous links, use **Upload a file** instead.

The site re-reads the link every 30 minutes. When a carrier isn't found, it also pulls a fresh copy right away, so someone you just approved shows as passing within a minute or two. Use **Check an MC number** to test.

Once a link is saved, updating the sheet is all you need to do. You don't have to touch the site again.

---

## Running it

### On your computer (to try it)

```bash
# Node.js 22.13+ required: https://nodejs.org
ADMIN_PASSWORD=choose-a-password npm start
# open http://localhost:3000/admin
```

On Windows PowerShell: `$env:ADMIN_PASSWORD="choose-a-password"; npm start`

### Putting it online (so carriers can reach it)

Any host that runs Node and has a **persistent disk** will work. Your loads and bids live in `data/loadboard.db`, so the disk has to survive restarts.

**Render.com (simplest):**
1. Put this folder in a GitHub repo. Render → New → **Blueprint** → pick the repo. The included `render.yaml` sets up the service and a 1 GB disk.
2. Set **ADMIN_PASSWORD** when Render prompts for it.
3. Use the `onrender.com` URL, or add your own domain, such as `loads.yourdomain.com`, under Settings → Custom Domains.
   The Starter plan with a disk costs about $7–8/month.

**Railway / Fly.io / a VPS / Docker:** a `Dockerfile` is included. Mount a volume at `/app/data` and set the environment variables below.

### Environment variables

| Variable | Required | What it does |
|---|---|---|
| `ADMIN_PASSWORD` | **yes** | Password for `/admin` |
| `PORT` | no | Defaults to 3000. Most hosts set this for you. |
| `DATA_DIR` | no | Folder for the database. Defaults to `./data`. |
| `SESSION_SECRET` | no | Signs admin logins. If you leave it out, one is generated and saved in the database. |
| `CARRIER_REFRESH_MINUTES` | no | How often the Highway sheet is re-read. Defaults to 30. |
| `GEOCODER_USER_AGENT` | no | Identifies your site to the free map lookup. Include your email, e.g. `BrockLoads/1.0 (codyp@sweetcandy.com)`. |
| `TIMEZONE` | no | Time zone for bid deadlines typed in sheets/imports. Defaults to `America/Denver`. |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | for email | Entra app "LOADBOARD". Its Mail.Send permission is limited in Exchange to the EMAIL_FROM mailbox only (RBAC for Applications, scope "Load Board mailbox"). |
| `EMAIL_FROM` | for email | `loads@brocktrans.com`. All emails are sent as this mailbox and saved in its Sent Items. |
| `PUBLIC_URL` | no | The address used in daily-email links, e.g. `https://loads.yourdomain.com`. Defaults to the address you're using. |
| `COOKIE_SECURE` | no | Set to `1` to force secure cookies. This happens automatically behind HTTPS on most hosts. |

### Maps and miles

The site uses free OpenStreetMap services, so no API key or billing is needed. Nominatim turns addresses into map points, OSRM calculates the driving route and miles, and OpenStreetMap supplies the map tiles. They're meant for light use, which a load board fits. If an address can't be found, the load shows **no map** in admin. Fix the city, state or ZIP and save again. You can also type miles in yourself.

### Backups

Copy `data/loadboard.db` now and then. On Render, use the Shell tab or a scheduled job.

## Files

```
server.js          web server, API, admin login
lib/db.js          database tables
lib/qualify.js     Highway list: reads Google Sheet / Excel / upload, checks MC numbers
lib/cost.js        break-even / market / margin estimate
lib/ops.js         address book, saved lanes + repeat posting, tracking, documents, carrier profiles, counters, reports
public/admin-ops.js  admin screens for the above
public/counter.html  carrier's accept/decline page for a counter offer
lib/sheet.js       CSV + XLSX reader
lib/geo.js         address → map point, route & miles
public/index.html  carrier load board
public/load.html   load detail, map, bid form
public/admin.html  admin area
public/styles.css  styling
```
