(function () {
  const status = document.getElementById("status");
  const title = document.getElementById("title");
  const content = document.getElementById("plan-content");
  const params = new URLSearchParams(window.location.search);
  const turnId = params.get("turnId");
  const itemId = params.get("itemId");
  const telegram = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const previewMode = window.location.pathname.indexOf("/preview/plan") !== -1;

  if (telegram) {
    telegram.ready();
    telegram.expand();
  }

  if (previewMode) {
    title.textContent = "Plan Preview";
    status.textContent = "Static preview";
    content.textContent = [
      "1. Audit the current plan artifact flow in kirbot.",
      "2. Add a Telegram Mini App route that serves exact completed plan artifacts.",
      "3. Replace raw plan bubbles with a compact stub and an Open plan button.",
      "4. Keep in-progress planning in Telegram status updates.",
      "5. Verify the Mini App against bridge, harness, and HTTP tests."
    ].join("\n");
    return;
  }

  if (!turnId || !itemId) {
    status.textContent = "This plan link is missing artifact details.";
    return;
  }

  const artifactUrl = new URL("./api/plan-artifact", window.location.href);
  artifactUrl.searchParams.set("turnId", turnId);
  artifactUrl.searchParams.set("itemId", itemId);

  fetch(artifactUrl.toString(), {
    headers: {
      "X-Telegram-Init-Data": telegram ? telegram.initData || "" : ""
    }
  })
    .then(async function (response) {
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "artifact_lookup_failed");
      }
      return payload;
    })
    .then(function (artifact) {
      title.textContent = artifact.title || "Plan";
      status.textContent = "Completed plan artifact";
      content.textContent = artifact.text || "(empty plan)";
    })
    .catch(function (error) {
      status.textContent = "Failed to load this plan artifact.";
      content.textContent = String(error && error.message ? error.message : error);
    });
})();
