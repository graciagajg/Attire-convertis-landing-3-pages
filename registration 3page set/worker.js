// worker.js — the single entry point for this Worker.
// Every request to your site passes through here first.
//
// Logic: if the request is for /api/subscribe, run the Kit relay.
// Otherwise, hand the request off to your static files (index.html,
// merci.html, images, etc.) exactly like before.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/subscribe" && request.method === "POST") {
      return handleSubscribe(request, env);
    }

    if (url.pathname === "/api/capture-lead" && request.method === "POST") {
      return handleCaptureLead(request, env);
    }

    // Not an API request — serve the matching static file as usual.
    return env.ASSETS.fetch(request);
  }
};

// Logs a checkout lead (name, email, phone, chosen plan) to KV before the
// visitor is sent to Whop. This is a manual cross-check log, not an
// automated payment-matching system — see the offre.html handler for
// how it's used. Never blocks the redirect to Whop.
async function handleCaptureLead(request, env) {
  let data;
  try {
    data = await request.json();
  } catch (err) {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  const { nom, email, tel, plan } = data;

  if (!email || !nom) {
    return jsonResponse({ ok: false, error: "missing_fields" }, 400);
  }

  if (!env.CHECKOUT_LEADS) {
    // Binding not set up yet — don't block checkout over a logging gap.
    return jsonResponse({ ok: true, logged: false });
  }

  const key = `lead:${Date.now()}:${email}`;
  try {
    await env.CHECKOUT_LEADS.put(key, JSON.stringify({
      nom, email, tel, plan,
      at: new Date().toISOString()
    }));
    return jsonResponse({ ok: true, logged: true });
  } catch (err) {
    // Logging failed, but don't block the visitor's checkout over it.
    return jsonResponse({ ok: true, logged: false });
  }
}

async function handleSubscribe(request, env) {
  let data;
  try {
    data = await request.json();
  } catch (err) {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  const { nom, email, tel } = data;

  if (!email || !nom) {
    return jsonResponse({ ok: false, error: "missing_fields" }, 400);
  }

  const apiKey = env.KIT_API_KEY;
  const formId = env.KIT_FORM_ID;
  const phoneFieldKey = env.PHONE_FIELD_KEY || "phone_number";

  const subscriberBody = {
    first_name: nom,
    email_address: email,
    state: "active",
    fields: {
      [phoneFieldKey]: tel || ""
    }
  };

  try {
    // Step 1: create or update the subscriber, with fields (name, phone)
    await callKitWithRetry(
      "https://api.kit.com/v4/subscribers",
      apiKey,
      subscriberBody
    );

    // Step 2: attach that subscriber to the form (this is what fires
    // whatever automation is wired to the form in Kit)
    await callKitWithRetry(
      `https://api.kit.com/v4/forms/${formId}/subscribers`,
      apiKey,
      { email_address: email }
    );

    return jsonResponse({ ok: true });

  } catch (err) {
    // Kit rejected the request (or was unreachable) after a retry.
    // Log everything we have so this person isn't silently lost.
    await logFailure(env, { nom, email, tel, error: err.message, at: new Date().toISOString() });
    return jsonResponse({ ok: false, error: "kit_failed" }, 502);
  }
}

// Calls Kit's API. Retries once on transient errors (429 rate limit,
// 500 server error) before giving up — this absorbs momentary blips
// so they don't get logged as real failures.
async function callKitWithRetry(url, apiKey, body, attempt = 1) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kit-Api-Key": apiKey
    },
    body: JSON.stringify(body)
  });

  if (res.ok) return res.json();

  if ((res.status === 429 || res.status === 500) && attempt === 1) {
    await new Promise(resolve => setTimeout(resolve, 800));
    return callKitWithRetry(url, apiKey, body, 2);
  }

  const errText = await res.text();
  throw new Error(`Kit ${res.status}: ${errText}`);
}

// Writes a failed submission to KV so it can be recovered manually.
// If the KV binding isn't set up yet, this just no-ops instead of
// crashing the whole request.
async function logFailure(env, details) {
  if (!env.FAILED_SUBSCRIBERS) return;
  const key = `failed:${Date.now()}:${details.email}`;
  try {
    await env.FAILED_SUBSCRIBERS.put(key, JSON.stringify(details));
  } catch (e) {
    // Nothing more we can do server-side at this point.
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
