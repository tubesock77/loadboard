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
- **Import loads**: upload a CSV or XLSX with many loads at once. Click **Download template** in that window for the column names. Common names also work, such as "Pickup City" or "Ship Date".
- **Bids**: bids are listed low to high, each marked **✓ Pass** or **✗ Not on list** for Highway, with $/mi and each bid's difference from your target. **Award** marks the load as covered and closes bidding. **Reopen for bids** undoes that.
- **Link**: copies the carrier link for a load. **Copy board link** copies the link to the whole board.
- **Edit → Duplicate**: copies a load as a draft, which is useful for repeat lanes. **Status** can be Open, Draft (hidden) or Closed.
- **Export all bids**: downloads a CSV of every bid.
- **Approved carriers**: paste your Google Sheet or Excel link, or upload a file. See below.
- **Settings**: company name, tagline, default contact info and the bid terms shown to carriers.

## Hooking up your Highway list

Export or copy your Highway-approved carriers into a Google Sheet or Excel file with a column of MC numbers. The site finds a column headed `MC`, `MC Number`, `MC #` or `Docket` on its own. If your column has a different name, enter it in the admin page. `MC123456`, `MC-123456` and `123456` all match.

**Google Sheets:** Share → General access → **Anyone with the link → Viewer**. Paste the normal sheet link in **Admin → Approved carriers**. If the list is on a tab other than the first one, open that tab before you copy the link so it includes `#gid=`.

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
lib/sheet.js       CSV + XLSX reader
lib/geo.js         address → map point, route & miles
public/index.html  carrier load board
public/load.html   load detail, map, bid form
public/admin.html  admin area
public/styles.css  styling
```
