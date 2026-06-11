# everycivicapp

The bot behind [@everycivicapp](https://bsky.app/profile/everycivicapp.bsky.social): once a day, it posts one civic tech tool from the [Civic Tech Field Guide](https://civictech.guide) to social media.

## How it works

1. Queries the Field Guide's Airtable base for listings that are typed "Tool or platform", have at least one category, are Active, and haven't been posted before (tracked with a "shared on @everytool" internal tag).
2. Picks one at random.
3. Composes a post: project name (with the project's own handle on that platform, when the Field Guide has it on record), its one-liner, its URL, and up to two category hashtags plus #CivicTech. Truncated to fit each platform's limit (300 chars on Bluesky, 500 elsewhere).
4. Posts it — to Bluesky and Mastodon via their APIs directly, and to Threads and Instagram via Buffer. The listing's screenshot is attached when one exists. Instagram is skipped for listings without an image.
5. Tags the listing in Airtable so it won't be posted again.

Each platform is optional: the bot posts to whichever ones have credentials configured and skips the rest. If every configured platform fails, the listing is not tagged, so the next run retries it.

## Running it

Requires Node 20+ and no npm dependencies.

Copy `.env.example` to `.env`, fill in your keys, then run this in your terminal: `node --env-file=.env daily-post.js`

To preview the post without publishing anything, run this in your terminal: `DRY_RUN=true node --env-file=.env daily-post.js`

## Running it on a schedule

The included GitHub Actions workflow (`.github/workflows/daily-social-post.yml`) runs the bot daily. To use it in your own fork:

1. Add the variables from `.env.example` as repository secrets (Settings → Secrets and variables → Actions).
2. Uncomment the `schedule` block in the workflow file.
3. Trigger the workflow once manually from the Actions tab to confirm the secrets work — newly pushed scheduled workflows often skip their first cron run.

## Adapting it

The Airtable base, table, and field IDs at the top of `daily-post.js` are specific to the Civic Tech Field Guide's base. To run this against your own Airtable base, replace those constants with your own IDs and mirror the schema: a listings table with name/one-liner/URL/type/status/categories/tags/image fields, a links table mapping listings to their social accounts, and a categories table.
