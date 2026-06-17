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

  // --- Other analytics / marketing ---
  "hotjar.com": { vendor: "Hotjar", name: "Hotjar", category: "analytics" },
  "hotjar.io": { vendor: "Hotjar", name: "Hotjar", category: "analytics" },
  "hs-scripts.com": { vendor: "HubSpot", name: "HubSpot", category: "marketing" },
  "hs-analytics.net": { vendor: "HubSpot", name: "HubSpot Analytics", category: "analytics" },
  "hubspot.com": { vendor: "HubSpot", name: "HubSpot", category: "marketing" },
  "tiktok.com": { vendor: "TikTok", name: "TikTok Pixel", category: "marketing" },
  "snapchat.com": { vendor: "Snap", name: "Snap Pixel", category: "marketing" },
  "twitter.com/i/adsct": { vendor: "X (Twitter)", name: "X Ads Pixel", category: "marketing" },
  "ads-twitter.com": { vendor: "X (Twitter)", name: "X Ads Pixel", category: "marketing" },
  "pinterest.com": { vendor: "Pinterest", name: "Pinterest Tag", category: "marketing" },

  // --- Functional / sharing / embeds ---
  "static.addtoany.com": { vendor: "AddToAny", name: "AddToAny Share", category: "functional" },
  "addevent.com": { vendor: "AddEvent", name: "AddEvent (Add to Calendar)", category: "functional" },

  // --- Accessibility widgets (functional; flag for human judgment, not a tracker) ---
  "userway.org": { vendor: "UserWay", name: "UserWay Accessibility", category: "functional" },
  "accessibilityserver.org": { vendor: "Accessibility Widget", name: "Accessibility Widget", category: "functional" },
  "accessibe.com": { vendor: "accessiBe", name: "accessiBe Accessibility", category: "functional" },
  "player.vimeo.com": { vendor: "Vimeo", name: "Vimeo Embed", category: "functional" },
  "vimeo.com": { vendor: "Vimeo", name: "Vimeo", category: "functional" },
  "use.typekit.net": { vendor: "Adobe", name: "Adobe Fonts (Typekit)", category: "functional" },
  "cdnjs.cloudflare.com": { vendor: "Cloudflare", name: "cdnjs", category: "functional" },

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
