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

  // Kit and Brevo fire in parallel. allSettled means neither one can
  // block or break the other — a Brevo failure never turns a working
  // Kit registration into an error, and vice versa.
  const [kitResult, brevoResult] = await Promise.allSettled([
    subscribeToKit(apiKey, formId, subscriberBody),
    subscribeToBrevo(env, { nom, email, tel })
  ]);

  if (kitResult.status === "rejected") {
    // Kit rejected the request (or was unreachable) after a retry.
    // Log everything we have so this person isn't silently lost.
    await logFailure(env, {
      source: "kit",
      nom, email, tel,
      error: kitResult.reason.message,
      at: new Date().toISOString()
    });
  }

  if (brevoResult.status === "rejected") {
    await logFailure(env, {
      source: "brevo",
      nom, email, tel,
      error: brevoResult.reason.message,
      at: new Date().toISOString()
    });
  }

  // Kit is the system this flow was originally built around, so its
  // outcome still drives the response code the form sees. Brevo
  // failing quietly never blocks or breaks the registration itself.
  if (kitResult.status === "rejected") {
    return jsonResponse({ ok: false, error: "kit_failed" }, 502);
  }

  return jsonResponse({ ok: true });
}

// Wraps the two-step Kit call (create/update subscriber, then attach
// to the form — the form attachment is what fires whatever automation
// is wired to it in Kit) so it can run inside Promise.allSettled above.
async function subscribeToKit(apiKey, formId, subscriberBody) {
  await callKitWithRetry(
    "https://api.kit.com/v4/subscribers",
    apiKey,
    subscriberBody
  );

  await callKitWithRetry(
    `https://api.kit.com/v4/forms/${formId}/subscribers`,
    apiKey,
    { email_address: subscriberBody.email_address }
  );
}

// Creates or updates the Brevo contact and adds them to the SMS
// reminder list (BREVO_LIST_ID). updateEnabled:true means a second
// registration from the same person updates the existing contact
// instead of throwing a duplicate-contact error.
async function subscribeToBrevo(env, { nom, email, tel }) {
  if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID) {
    throw new Error("Brevo env vars not configured");
  }

  const listIds = [parseInt(env.BREVO_LIST_ID, 10)];
  const firstNameKey = env.BREVO_FIRSTNAME_KEY || "FIRSTNAME";
  const headers = {
    "Content-Type": "application/json",
    "api-key": env.BREVO_API_KEY
  };

  const res = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      email,
      attributes: { [firstNameKey]: nom, SMS: tel || "" },
      listIds,
      updateEnabled: true
    })
  });

  if (res.ok) {
    // Brevo returns 204 No Content (empty body) when updateEnabled
    // updates a contact that already existed, vs 201 with a JSON body
    // for a brand-new contact — only parse JSON when there's a body,
    // or res.json() throws on the empty response and this gets
    // miscounted as a failure even though Brevo succeeded.
    if (res.status === 204) return null;
    return res.json();
  }

  const errText = await res.text();

  if (res.status === 400 && errText.includes("duplicate_parameter") && errText.includes("SMS") && tel) {
    // This phone number already belongs to a different Brevo contact
    // than the one matching this email — most often a returning
    // registrant using a new email this time. updateEnabled can't
    // resolve this: it only dedupes on the identifier we keyed the
    // request by (email), not on a second unique field someone else
    // already owns. So look that contact up directly by phone instead
    // of trying (and failing) to create a disconnected second record —
    // this is what keeps the phone number attached for the SMS list.
    return updateBrevoContactByPhone(env, { nom, email, tel, listIds, firstNameKey, headers });
  }

  throw new Error(`Brevo ${res.status}: ${errText}`);
}

// Reunites a returning registrant with their existing Brevo contact by
// looking it up via phone number (identifierType=phone_id) instead of
// email, then updating that contact's email/name/list membership.
async function updateBrevoContactByPhone(env, { nom, email, tel, listIds, firstNameKey, headers }) {
  const phonePath = encodeURIComponent(tel);
  const url = `https://api.brevo.com/v3/contacts/${phonePath}?identifierType=phone_id`;

  const res = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({ email, attributes: { [firstNameKey]: nom }, listIds })
  });

  if (res.ok) return null; // Brevo's contact-update endpoint always returns 204.

  const errText = await res.text();

  if (res.status === 400 && errText.includes("duplicate_parameter") && errText.includes("EMAIL")) {
    // Rare double-collision: the new email also already belongs to a
    // third, unrelated contact. Update the phone-owning contact's name
    // and list without touching email, and flag it for a manual look
    // rather than losing the registration entirely.
    const retry = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ attributes: { [firstNameKey]: nom }, listIds })
    });

    if (retry.ok) {
      await logManualReviewNote(env, {
        nom, email, tel,
        reason: "email_also_claimed_by_another_contact"
      });
      return null;
    }

    const retryErr = await retry.text();
    throw new Error(`Brevo ${retry.status}: ${retryErr}`);
  }

  throw new Error(`Brevo ${res.status}: ${errText}`);
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

// Writes a note to the same KV under a "conflict:" prefix instead of
// "failed:" — for a registration that succeeded (person landed on the
// list) but needs a manual look, rather than a real failure. Currently
// used only for the rare double-collision in updateBrevoContactByPhone
// (their phone AND their new email each already belong to someone
// else), since the common phone-reunite case now resolves on its own.
async function logManualReviewNote(env, details) {
  if (!env.FAILED_SUBSCRIBERS) return;
  const key = `conflict:${Date.now()}:${details.email}`;
  try {
    await env.FAILED_SUBSCRIBERS.put(key, JSON.stringify({
      ...details,
      at: new Date().toISOString()
    }));
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
