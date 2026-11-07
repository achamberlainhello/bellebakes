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

## Holiday pre-orders

`HOLIDAY` near the top of the script sets the chocolate peppermint pre-orders: 10 bundles for Friday, December 4 (pre-orders close Monday, November 30 at 10am) and 10 for Friday, December 11 (close Monday, December 7 at 10am). Unlike the weekly menu, these counts don't reset on Fridays, and the form stays open for them even while the weekly menu is sold out or closed. Holiday-only customers pick "Holiday pre-order only" as their pickup. Running `setup` adds the questions to the form and schedules each date's close. Once the season is over, the holiday heading and questions can be deleted from the form. For a future season, change the dates in `HOLIDAY` and run `setup` again.

After changing the script's code (not just these settings), also update the website's live counts: Deploy → Manage deployments → edit → Version: New version → Deploy.
