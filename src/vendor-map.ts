import type { Category } from "./types.js";

/**
 * Self-maintained vendor map (CLAUDE.md §3, Appendix A).
 *
 * IMPORTANT: This is intentionally a small, hand-curated map covering the common
 * trackers. Do NOT bundle the DuckDuckGo Tracker Radar dataset — it is CC BY-NC-SA
 * (non-commercial). Tracker Radar may be used as a *reference* to seed entries here,
 * but the data shipped in this file must be our own.
 *
 * Keys are matched as substrings against a request's hostname (+ pathname for the
 * reCAPTCHA case). Add entries as we encounter new vendors during audits.
 */

export interface VendorEntry {
  vendor: string;
  name: string;
  category: Category;
  /** Human-readable purpose for the report. Defaults derived from category if omitted. */
  purpose?: string;
  /** Where the data ends up. Defaults to `vendor` if omitted. */
  dataRecipient?: string;
}

export const VENDOR_MAP: Record<string, VendorEntry> = {
  // --- Google ---
  "google-analytics.com": { vendor: "Google", name: "Google Analytics (GA4)", category: "analytics" },
  "analytics.google.com": { vendor: "Google", name: "Google Analytics (GA4)", category: "analytics" },
  "googletagmanager.com": { vendor: "Google", name: "Google Tag Manager", category: "functional" },
  "maps.googleapis.com": { vendor: "Google", name: "Google Maps", category: "functional" },
  "maps.google.com": { vendor: "Google", name: "Google Maps", category: "functional" },
  "google.com/recaptcha": { vendor: "Google", name: "reCAPTCHA", category: "functional" },
  "gstatic.com/recaptcha": { vendor: "Google", name: "reCAPTCHA", category: "functional" },
  "googlesyndication.com": { vendor: "Google", name: "Google Ads / AdSense", category: "marketing" },
  "googleadservices.com": { vendor: "Google", name: "Google Ads Conversion", category: "marketing" },
  "doubleclick.net": { vendor: "Google", name: "Google DoubleClick", category: "marketing" },
  "youtube.com": { vendor: "Google", name: "YouTube Embed", category: "marketing" },
  "youtube-nocookie.com": { vendor: "Google", name: "YouTube (no-cookie)", category: "functional" },
  "fonts.googleapis.com": { vendor: "Google", name: "Google Fonts", category: "functional" },
  "fonts.gstatic.com": { vendor: "Google", name: "Google Fonts", category: "functional" },
  "ajax.googleapis.com": { vendor: "Google", name: "Google Hosted Libraries (jQuery)", category: "functional" },
  "apis.google.com": { vendor: "Google", name: "Google API (apis.google.com)", category: "functional" },

  // --- Meta ---
  "connect.facebook.net": { vendor: "Meta", name: "Meta Pixel", category: "marketing" },
  "facebook.com/tr": { vendor: "Meta", name: "Meta Pixel", category: "marketing" },

  // --- LinkedIn ---
  "snap.licdn.com": { vendor: "LinkedIn", name: "LinkedIn Insight Tag", category: "marketing" },
  "px.ads.linkedin.com": { vendor: "LinkedIn", name: "LinkedIn Ads", category: "marketing" },

  // --- Microsoft ---
  "clarity.ms": { vendor: "Microsoft", name: "Microsoft Clarity", category: "analytics" },
  "bat.bing.com": { vendor: "Microsoft", name: "Microsoft Bing Ads (UET)", category: "marketing" },
  "bing.com": { vendor: "Microsoft", name: "Microsoft Bing Ads", category: "marketing" },

  // --- Other analytics / marketing ---
  "hotjar.com": { vendor: "Hotjar", name: "Hotjar", category: "analytics" },
  "hotjar.io": { vendor: "Hotjar", name: "Hotjar", category: "analytics" },
  "hs-scripts.com": { vendor: "HubSpot", name: "HubSpot", category: "marketing" },
  "hs-analytics.net": { vendor: "HubSpot", name: "HubSpot Analytics", category: "analytics" },
  "hubspot.com": { vendor: "HubSpot", name: "HubSpot", category: "marketing" },
  // hsforms.com / .net substring also matches js.hsforms.net, forms.hsforms.com, forms-na2.hsforms.com
  "hsforms.com": { vendor: "HubSpot", name: "HubSpot Forms", category: "marketing" },
  "hsforms.net": { vendor: "HubSpot", name: "HubSpot Forms", category: "marketing" },
  "hscollectedforms.net": { vendor: "HubSpot", name: "HubSpot Forms", category: "marketing" },
  "hs-banner.com": { vendor: "HubSpot", name: "HubSpot Banner", category: "marketing" },
  "tiktok.com": { vendor: "TikTok", name: "TikTok Pixel", category: "marketing" },
  "snapchat.com": { vendor: "Snap", name: "Snap Pixel", category: "marketing" },
  "twitter.com/i/adsct": { vendor: "X (Twitter)", name: "X Ads Pixel", category: "marketing" },
  "ads-twitter.com": { vendor: "X (Twitter)", name: "X Ads Pixel", category: "marketing" },
  "pinterest.com": { vendor: "Pinterest", name: "Pinterest Tag", category: "marketing" },

  // --- Programmatic advertising / ad-tech (marketing) ---
  "adnxs.com": { vendor: "Microsoft (Xandr)", name: "AppNexus / Xandr", category: "marketing" },
  "adsrvr.org": { vendor: "The Trade Desk", name: "The Trade Desk", category: "marketing" },
  "casalemedia.com": { vendor: "Index Exchange", name: "Index Exchange", category: "marketing" },
  "pubmatic.com": { vendor: "PubMatic", name: "PubMatic", category: "marketing" },
  "rubiconproject.com": { vendor: "Magnite", name: "Magnite (Rubicon Project)", category: "marketing" },
  "bidswitch.net": { vendor: "BidSwitch", name: "BidSwitch", category: "marketing" },
  "demdex.net": { vendor: "Adobe", name: "Adobe Audience Manager", category: "marketing" },
  "tapad.com": { vendor: "Tapad", name: "Tapad", category: "marketing" },
  "agkn.com": { vendor: "Neustar", name: "Neustar AdvertisingCloud", category: "marketing" },
  "media6degrees.com": { vendor: "Dstillery", name: "Dstillery", category: "marketing" },
  "simpli.fi": { vendor: "Simpli.fi", name: "Simpli.fi", category: "marketing" },
  "vibe.co": { vendor: "Vibe", name: "Vibe (CTV ads)", category: "marketing" },
  "mdhv.io": { vendor: "Mediavine", name: "Mediavine", category: "marketing" },
  "addthis.com": { vendor: "Oracle", name: "AddThis", category: "marketing" },
  "clickcease.com": { vendor: "ClickCease", name: "ClickCease", category: "marketing" },
  "reachlocalservices.com": { vendor: "ReachLocal", name: "ReachLocal", category: "marketing" },
  "merchant-center-analytics.goog": { vendor: "Google", name: "Google Merchant Center", category: "marketing" },
  "imrworldwide.com": { vendor: "Nielsen", name: "Nielsen Measurement", category: "marketing" },

  // --- Analytics / heatmaps ---
  "crazyegg.com": { vendor: "Crazy Egg", name: "Crazy Egg", category: "analytics" },
  "atrk.js": { vendor: "atrk", name: "atrk Web Metrics", category: "analytics" },
  "alexametrics.com": { vendor: "Alexa Metrics", name: "Alexa / atrk Metrics", category: "analytics" },

  // --- Functional / sharing / embeds ---
  "static.addtoany.com": { vendor: "AddToAny", name: "AddToAny Share", category: "functional" },
  "addevent.com": { vendor: "AddEvent", name: "AddEvent (Add to Calendar)", category: "functional" },

  // --- Accessibility widgets (functional; flag for human judgment, not a tracker) ---
  "userway.org": { vendor: "UserWay", name: "UserWay Accessibility", category: "functional" },
  "accessibilityserver.org": { vendor: "Accessibility Widget", name: "Accessibility Widget", category: "functional" },
  "accessibe.com": { vendor: "accessiBe", name: "accessiBe Accessibility", category: "functional" },
  "player.vimeo.com": { vendor: "Vimeo", name: "Vimeo Embed", category: "functional" },
  "vimeo.com": { vendor: "Vimeo", name: "Vimeo", category: "functional" },
  "vimeocdn.com": { vendor: "Vimeo", name: "Vimeo (CDN)", category: "functional" },
  "calendly.com": { vendor: "Calendly", name: "Calendly Scheduling", category: "functional" },
  "apex.live": { vendor: "ApexChat", name: "ApexChat (live chat)", category: "functional" },
  "vialivechat.com": { vendor: "ApexChat", name: "ViaLiveChat / ApexChat (live chat)", category: "functional" },
  "captivate.fm": { vendor: "Captivate", name: "Captivate Podcast Player", category: "functional" },
  "ctctcdn.com": { vendor: "Constant Contact", name: "Constant Contact", category: "marketing" },
  "constantcontact.com": { vendor: "Constant Contact", name: "Constant Contact", category: "marketing" },
  "pantheonsite.io": { vendor: "Pantheon", name: "Pantheon (hosting)", category: "necessary" },
  "stripe.com": { vendor: "Stripe", name: "Stripe (payment)", category: "necessary" },
  "stripe.network": { vendor: "Stripe", name: "Stripe (payment)", category: "necessary" },
  "zendesk.com": { vendor: "Zendesk", name: "Zendesk (support chat)", category: "functional" },
  "zdassets.com": { vendor: "Zendesk", name: "Zendesk (assets)", category: "functional" },
  "hcaptcha.com": { vendor: "hCaptcha", name: "hCaptcha", category: "functional" },
  "tripleseat.com": { vendor: "Tripleseat", name: "Tripleseat (event booking)", category: "functional" },
  "icomoon.io": { vendor: "IcoMoon", name: "IcoMoon (icon font)", category: "functional" },
  "typekit.net": { vendor: "Adobe", name: "Adobe Fonts (Typekit)", category: "functional" },
  "gstatic.com": { vendor: "Google", name: "Google Static Content", category: "functional" },
  "googlevideo.com": { vendor: "Google", name: "YouTube (video CDN)", category: "functional" },
  "ss-gtm.com": { vendor: "Google", name: "Server-side Google Tag Manager", category: "functional" },
  "use.typekit.net": { vendor: "Adobe", name: "Adobe Fonts (Typekit)", category: "functional" },
  "cdnjs.cloudflare.com": { vendor: "Cloudflare", name: "cdnjs", category: "functional" },
  "challenges.cloudflare.com": { vendor: "Cloudflare", name: "Cloudflare Turnstile (CAPTCHA)", category: "functional" },
  "ytimg.com": { vendor: "Google", name: "YouTube (static images)", category: "functional" },

  // --- Performance / monitoring (functional) ---
  "newrelic.com": { vendor: "New Relic", name: "New Relic", category: "functional" },
  "nr-data.net": { vendor: "New Relic", name: "New Relic", category: "functional" },

  // --- Dev / QA tools that should not be on production (CLAUDE.md §6) ---
  "bugherd.com": { vendor: "BugHerd", name: "BugHerd (QA)", category: "non-essential" },
  "sidebar.bugherd.com": { vendor: "BugHerd", name: "BugHerd (QA sidebar)", category: "non-essential" },
};

const PURPOSE_BY_CATEGORY: Record<Category, string> = {
  necessary: "Strictly necessary",
  functional: "Functional",
  analytics: "Analytics",
  marketing: "Marketing / Advertising",
  "non-essential": "Non-essential",
  unknown: "Unclassified third party",
};

/**
 * Look up a captured request URL against the vendor map.
 * Matches the full `host + pathname` so path-scoped keys (e.g. google.com/recaptcha) work.
 */
export function lookupVendor(url: string): VendorEntry | null {
  let haystack: string;
  try {
    const u = new URL(url);
    haystack = u.host + u.pathname;
  } catch {
    haystack = url;
  }
  for (const [key, entry] of Object.entries(VENDOR_MAP)) {
    if (haystack.includes(key)) {
      return {
        ...entry,
        purpose: entry.purpose ?? PURPOSE_BY_CATEGORY[entry.category],
        dataRecipient: entry.dataRecipient ?? entry.vendor,
      };
    }
  }
  return null;
}
