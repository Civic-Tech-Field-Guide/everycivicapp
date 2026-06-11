// daily-post.js — posts one civic tech tool per day
// Bluesky + Mastodon: direct platform APIs
// Threads + Instagram: via Buffer

const AT_BASE     = "appYHxsLYleU2RVYk";
const AT_LISTINGS = "tblELFP9tGX07UZDo";
const AT_LINKS    = "tblpRr3lPFncgTS8y";
const AT_CATS     = "tblxtu4Bm8QCcuuek";
const BUFFER_URL  = "https://api.buffer.com";
const BSKY_API    = "https://bsky.social/xrpc";

// Listings field IDs
const F = {
  name:       "fldc8kUYwodsQJvIy",
  oneLiner:   "fld8kPHKN1jtekFEF",
  url:        "fldiaFhY8seaUpS6j",
  type:       "fld85Qsj7sU56liv9",
  status:     "fldw9vTztFwBOrcue",
  categories: "fldXGB674po9h9xtB",
  tags:       "fldDDURDAjFSe9qTr",
  images:     "flduyp7dlnOPqiEpu",  // "File (from Images)" lookup — S3 URLs from linked Media records
};

// Links table field IDs
const LF = {
  listing: "fldQ9ByIfzzFqvJcy",
  url:     "fldfJ5N0rECMxNiw5",
  type:    "fldZD5TbZ8P2cp39U",
};

// Categories table primary field
const CF_NAME = "fld8qGXZCm0nE2vSj";

// Links.Type option names → normalized platform key
const LINK_NAME_TO_PLATFORM = { Bluesky: "bluesky", Mastodon: "mastodon", Instagram: "instagram" };

// Buffer service names we'll post to (Threads + Instagram only — Bluesky/Mastodon go direct)
const BUFFER_TARGET_SERVICES = new Set(["threads", "instagram"]);

const DRY_RUN = process.env.DRY_RUN === "true";

// ─── Airtable helper ──────────────────────────────────────────────────────────

function atFetch(tableId, path = "", opts = {}) {
  return fetch(`https://api.airtable.com/v0/${AT_BASE}/${tableId}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    ...opts,
  }).then(async r => {
    if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
    return r.json();
  });
}

// ─── Airtable queries ─────────────────────────────────────────────────────────

async function fetchEligibleListings() {
  const formula = encodeURIComponent(
    `AND(` +
    `FIND("Tool or platform",ARRAYJOIN({${F.type}},",")),` +
    `ARRAYJOIN({${F.categories}},"")!="",` +
    `{${F.status}}="Active",` +
    `NOT(FIND("shared on @everytool",ARRAYJOIN({${F.tags}},",")))` +
    `)`
  );
  const fields = [F.name, F.oneLiner, F.url, F.categories, F.tags, F.images]
    .map(id => `fields[]=${id}`).join("&");

  let all = [], offset;
  do {
    const qs = `?filterByFormula=${formula}&${fields}&returnFieldsByFieldId=true&pageSize=100` +
               (offset ? `&offset=${offset}` : "");
    const data = await atFetch(AT_LISTINGS, qs);
    all.push(...(data.records ?? []));
    offset = data.offset;
  } while (offset);
  return all;
}

async function fetchCategoryNames(ids) {
  if (!ids.length) return [];
  const formula = encodeURIComponent(`OR(${ids.map(id => `RECORD_ID()="${id}"`).join(",")})`);
  const data = await atFetch(AT_CATS, `?filterByFormula=${formula}&fields[]=${CF_NAME}&returnFieldsByFieldId=true`);
  return (data.records ?? [])
    .map(r => (r.fields[CF_NAME] ?? "").replace(/\n/g, " ").trim())
    .filter(Boolean);
}

async function fetchSocialLinks(recordId) {
  const formula = encodeURIComponent(`FIND("${recordId}",ARRAYJOIN({${LF.listing}},","))`);
  const data = await atFetch(AT_LINKS, `?filterByFormula=${formula}&fields[]=${LF.url}&fields[]=${LF.type}&returnFieldsByFieldId=true`);
  const links = {};
  for (const r of data.records ?? []) {
    const rawType = r.fields[LF.type];
    const typeName = rawType?.name ?? rawType;
    const url = r.fields[LF.url];
    if (!url || !typeName) continue;
    const platform = LINK_NAME_TO_PLATFORM[typeName];
    if (platform) links[platform] = url;
  }
  return links;
}

async function markAsPosted(recordId) {
  const data = await atFetch(AT_LISTINGS, `/${recordId}?returnFieldsByFieldId=true`);
  const existing = (data.fields[F.tags] ?? []).map(t => t.name ?? t);
  const updated = [...new Set([...existing, "shared on @everytool"])];
  await atFetch(AT_LISTINGS, `/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({ typecast: true, fields: { [F.tags]: updated } }),
  });
}

// ─── Image download (shared by Bluesky + Mastodon, which need raw bytes) ──────

async function downloadImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Image download failed: ${r.status}`);
  const buffer = Buffer.from(await r.arrayBuffer());
  const mimeType = r.headers.get("content-type") || "image/jpeg";
  return { buffer, mimeType };
}

// ─── Bluesky (direct XRPC API — adapted from social-pipeline) ─────────────────

async function bskyRequest(method, path, body, token, contentType) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (Buffer.isBuffer(body)) {
    headers["Content-Type"] = contentType;
    payload = body;
  } else if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const r = await fetch(`${BSKY_API}${path}`, { method, headers, body: payload });
  const json = await r.json();
  if (!r.ok) throw new Error(`Bluesky ${path} ${r.status}: ${json.message ?? JSON.stringify(json)}`);
  return json;
}

async function postToBluesky(text, image) {
  const session = await bskyRequest("POST", "/com.atproto.server.createSession", {
    identifier: process.env.BLUESKY_HANDLE,
    password: process.env.BLUESKY_APP_PASSWORD,
  });

  let embed;
  if (image) {
    const blob = await bskyRequest("POST", "/com.atproto.repo.uploadBlob", image.buffer, session.accessJwt, image.mimeType);
    embed = { $type: "app.bsky.embed.images", images: [{ image: blob.blob, alt: "" }] };
  }

  const record = await bskyRequest("POST", "/com.atproto.repo.createRecord", {
    repo: session.did,
    collection: "app.bsky.feed.post",
    record: {
      $type: "app.bsky.feed.post",
      text,
      createdAt: new Date().toISOString(),
      ...(embed ? { embed } : {}),
    },
  }, session.accessJwt);

  return record.uri;
}

// ─── Mastodon (direct REST API) ────────────────────────────────────────────────

function mastodonUrl(path) {
  return `${process.env.MASTODON_INSTANCE_URL.replace(/\/$/, "")}${path}`;
}

async function postToMastodon(text, image) {
  let mediaIds;
  if (image) {
    const form = new FormData();
    form.append("file", new Blob([image.buffer], { type: image.mimeType }), "image.jpg");
    const r = await fetch(mastodonUrl("/api/v1/media"), {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.MASTODON_ACCESS_TOKEN}` },
      body: form,
    });
    const json = await r.json();
    if (!r.ok) throw new Error(`Mastodon media ${r.status}: ${JSON.stringify(json)}`);
    mediaIds = [json.id];
  }

  const r = await fetch(mastodonUrl("/api/v1/statuses"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MASTODON_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: text, ...(mediaIds ? { media_ids: mediaIds } : {}) }),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`Mastodon statuses ${r.status}: ${JSON.stringify(json)}`);
  return json.url ?? json.uri ?? json.id;
}

// ─── Buffer (GraphQL) — Threads + Instagram only ───────────────────────────────

async function bufferGql(query) {
  const r = await fetch(BUFFER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.BUFFER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`Buffer API ${r.status}: ${await r.text()}`);
  const json = await r.json();
  if (json.errors?.length) throw new Error(`Buffer GQL: ${json.errors.map(e => e.message).join("; ")}`);
  return json.data;
}

async function getTargetChannels() {
  const { account } = await bufferGql(`query { account { organizations { id } } }`);
  const orgId = account?.organizations?.[0]?.id;
  if (!orgId) throw new Error("No Buffer organization found");
  const { channels } = await bufferGql(
    `query { channels(input: { organizationId: ${JSON.stringify(orgId)} }) { id service } }`
  );
  return (channels ?? []).filter(c => BUFFER_TARGET_SERVICES.has(c.service?.toLowerCase()));
}

async function postToChannel(channelId, text, imageUrl, service) {
  const assetsPart = imageUrl
    ? `, assets: [{ image: { url: ${JSON.stringify(imageUrl)} } }]`
    : "";
  // Instagram requires explicit post-type metadata, or Buffer rejects the post
  const metadataPart = service === "instagram"
    ? `, metadata: { instagram: { type: post, shouldShareToFeed: true } }`
    : "";
  const mutation = `mutation {
    createPost(input: {
      channelId: ${JSON.stringify(channelId)},
      text: ${JSON.stringify(text)},
      schedulingType: automatic,
      mode: addToQueue${assetsPart}${metadataPart}
    }) {
      ... on PostActionSuccess { post { id } }
      ... on MutationError { message }
    }
  }`;
  const result = await bufferGql(mutation);
  return result?.createPost;
}

// ─── Post composition ─────────────────────────────────────────────────────────

function extractHandle(url, platform) {
  try {
    const u = new URL(url);
    if (platform === "bluesky") {
      const m = u.pathname.match(/\/profile\/([^/]+)/);
      if (m && !m[1].startsWith("did:")) return `@${m[1]}`;
    } else if (platform === "mastodon") {
      const m = u.pathname.match(/\/@([^/]+)/);
      if (m) return `@${m[1]}@${u.hostname}`;
    } else if (platform === "instagram" || platform === "threads") {
      const m = u.pathname.replace(/\/$/, "").match(/\/?@?([^/]+)$/);
      if (m?.[1]) return `@${m[1]}`;
    }
  } catch {}
  return null;
}

function toHashtag(name) {
  return "#" + name
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

// maxLength: if set, truncates the one-liner so the full post fits (Bluesky = 300)
function composePost(listing, categoryNames, handle, maxLength) {
  const name     = listing.fields[F.name] ?? "";
  const oneLiner = (listing.fields[F.oneLiner] ?? "").trim();
  const url      = listing.fields[F.url] ?? "";
  const hashtags = [...categoryNames.slice(0, 2).map(toHashtag), "#CivicTech"].join(" ");
  const title    = handle ? `${name} (${handle})` : name;

  const build = liner => [title, "", liner, "", url, "", hashtags].join("\n");
  let post = build(oneLiner);

  if (maxLength && post.length > maxLength) {
    const overage = post.length - maxLength;
    const truncated = oneLiner.slice(0, Math.max(0, oneLiner.length - overage - 1)).trimEnd() + "…";
    post = build(truncated);
  }

  return post;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.AIRTABLE_API_KEY) throw new Error("AIRTABLE_API_KEY is required");

  const hasBluesky  = !!(process.env.BLUESKY_HANDLE && process.env.BLUESKY_APP_PASSWORD);
  const hasMastodon = !!(process.env.MASTODON_INSTANCE_URL && process.env.MASTODON_ACCESS_TOKEN);
  const hasBuffer   = !!process.env.BUFFER_API_KEY;

  if (!DRY_RUN && !hasBluesky && !hasMastodon && !hasBuffer) {
    throw new Error("No platform credentials configured (need Bluesky, Mastodon, and/or Buffer)");
  }

  console.log("Fetching eligible listings…");
  const listings = await fetchEligibleListings();
  if (!listings.length) {
    console.log("No eligible listings found — nothing to post.");
    return;
  }

  const listing = listings[Math.floor(Math.random() * listings.length)];
  const listingName = listing.fields[F.name] ?? "(unknown)";
  console.log(`Selected: ${listingName} (${listing.id}) — ${listings.length} eligible`);

  const categoryIds = listing.fields[F.categories] ?? [];
  const [categoryNames, socialLinks] = await Promise.all([
    fetchCategoryNames(categoryIds),
    fetchSocialLinks(listing.id),
  ]);

  const imageUrls = (listing.fields[F.images] ?? []).filter(Boolean);
  const imageUrl = imageUrls[0] ?? null;

  console.log(`Categories: ${categoryNames.join(", ") || "none"}`);
  console.log(`Image: ${imageUrl ?? "none"}`);
  console.log(`Social links: ${JSON.stringify(socialLinks)}`);

  if (DRY_RUN) {
    const preview = composePost(listing, categoryNames, null, 300);
    console.log("\n─── DRY RUN — post preview (300 char limit, Bluesky-style) ───\n");
    console.log(preview);
    console.log(`\n(${preview.length} chars)`);
    console.log("\n─── end preview ──────────────────────────────────────────────\n");
    return;
  }

  let image = null;
  if (imageUrl) {
    try {
      image = await downloadImage(imageUrl);
    } catch (err) {
      console.error(`Image download failed, posting without image: ${err.message}`);
    }
  }

  let posted = 0;

  if (hasBluesky) {
    const handle = socialLinks.bluesky ? extractHandle(socialLinks.bluesky, "bluesky") : null;
    const text = composePost(listing, categoryNames, handle, 300);
    try {
      const uri = await postToBluesky(text, image);
      console.log(`✓ bluesky: ${uri}`);
      posted++;
    } catch (err) {
      console.error(`✗ bluesky: ${err.message}`);
    }
  }

  if (hasMastodon) {
    const handle = socialLinks.mastodon ? extractHandle(socialLinks.mastodon, "mastodon") : null;
    const text = composePost(listing, categoryNames, handle, 500);
    try {
      const url = await postToMastodon(text, image);
      console.log(`✓ mastodon: ${url}`);
      posted++;
    } catch (err) {
      console.error(`✗ mastodon: ${err.message}`);
    }
  }

  if (hasBuffer) {
    const channels = await getTargetChannels();
    console.log(`Buffer channels: ${channels.map(c => c.service).join(", ") || "none"}`);
    for (const ch of channels) {
      const service = ch.service.toLowerCase();
      if (service === "instagram" && !imageUrl) {
        console.log("Skipping Instagram — no image available for this listing");
        continue;
      }
      const linkUrl = socialLinks[service] ?? (service === "threads" ? socialLinks.instagram : null);
      const handle = linkUrl ? extractHandle(linkUrl, service) : null;
      const text = composePost(listing, categoryNames, handle, 500);
      try {
        const result = await postToChannel(ch.id, text, imageUrl, service);
        if (result?.post?.id) {
          console.log(`✓ ${service}: Buffer post ${result.post.id}`);
          posted++;
        } else {
          console.error(`✗ ${service}: ${JSON.stringify(result)}`);
        }
      } catch (err) {
        console.error(`✗ ${service}: ${err.message}`);
      }
    }
  }

  if (posted > 0) {
    await markAsPosted(listing.id);
    console.log(`Marked "${listingName}" as posted.`);
  } else {
    throw new Error("No platforms received the post — not marking as posted.");
  }
}

main().catch(err => { console.error(err.message ?? err); process.exit(1); });
