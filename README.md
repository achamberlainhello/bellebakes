# bellebakes
Sourdough and cookie orders on Stanford campus.

- `index.html` – bakery homepage with this week's menu and pricing, and an "Order here" button that opens Annabelle's Google Form.
- `coaching.html` – life coaching page, linking to the coaching site.
- `form-script/weekly-limits.gs` – the order form's Apps Script (weekly limits, pickup days, live counts for the website). A copy of what's installed in Annabelle's "Belle Bakes order limits" project.

To change the order form, swap the Google Form link on the "Order here" button in `index.html`.

## Weekly options (Apps Script → pick the function next to Run → Run)

Both last only for the current week and clear themselves when orders reopen Friday at 8pm. The form and the website update within a minute.

- **Close sales early ("sold out"):** `cookiesSoldOut` or `sourdoughSoldOut` stops that item right away, even if it hasn't reached its count, e.g. when fewer were prepped or ingredients ran short. The form shows "Sold out this week" and so does the website. `undoSoldOut` brings it back.
- **Fewer than usual this week:** set `THIS_WEEK_TOTALS` near the top of the script (e.g. `{ sourdough: 6 }`), save, then run `limitThisWeek`. Orders already placed count toward it, and it's split across Thursday and Friday the usual way. `undoLimitThisWeek` goes back to the normal limits.

After changing the script's code (not just these settings), also update the website's live counts: Deploy → Manage deployments → edit → Version: New version → Deploy.
