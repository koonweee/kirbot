<script lang="ts">
  import { env } from "$env/dynamic/public";
  import { onMount } from "svelte";

  type PlanArtifact = {
    turnId: string;
    itemId: string;
    title: string;
    text: string;
  };

  type ViewState =
    | { kind: "loading"; title: string; status: string }
    | { kind: "ready"; title: string; status: string; artifact: PlanArtifact }
    | { kind: "error"; title: string; status: string; detail: string };

  let state: ViewState = {
    kind: "loading",
    title: "Plan",
    status: "Loading plan artifact…"
  };

  onMount(() => {
    const telegram = window.Telegram?.WebApp ?? null;
    telegram?.ready();
    telegram?.expand();

    const turnId = new URLSearchParams(window.location.search).get("turnId")?.trim() ?? "";
    const itemId = new URLSearchParams(window.location.search).get("itemId")?.trim() ?? "";
    if (!turnId || !itemId) {
      state = {
        kind: "error",
        title: "Plan",
        status: "This plan link is missing artifact details.",
        detail: "Missing turnId or itemId."
      };
      return;
    }

    const apiUrl = buildArtifactUrl(turnId, itemId);
    if (!apiUrl) {
      state = {
        kind: "error",
        title: "Plan",
        status: "This app is missing its kirbot API configuration.",
        detail: "PUBLIC_KIRBOT_PLAN_API_BASE_URL is not set to a valid HTTPS URL."
      };
      return;
    }

    void fetch(apiUrl, {
      headers: {
        "X-Telegram-Init-Data": telegram?.initData ?? ""
      }
    })
      .then(async (response) => {
        const payload = (await response.json()) as Partial<PlanArtifact> & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "artifact_lookup_failed");
        }
        return payload as PlanArtifact;
      })
      .then((artifact) => {
        state = {
          kind: "ready",
          title: artifact.title || "Plan",
          status: "Completed plan artifact",
          artifact
        };
      })
      .catch((error: unknown) => {
        state = {
          kind: "error",
          title: "Plan",
          status: "Failed to load this plan artifact.",
          detail: error instanceof Error ? error.message : String(error)
        };
      });
  });

  function buildArtifactUrl(turnId: string, itemId: string): string | null {
    const apiBaseUrl = env.PUBLIC_KIRBOT_PLAN_API_BASE_URL;
    if (!apiBaseUrl) {
      return null;
    }

    try {
      const normalizedBaseUrl = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
      const url = new URL("api/plan-artifact", normalizedBaseUrl);
      if (url.protocol !== "https:") {
        return null;
      }
      url.searchParams.set("turnId", turnId);
      url.searchParams.set("itemId", itemId);
      return url.toString();
    } catch {
      return null;
    }
  }
</script>

<svelte:head>
  <title>{state.title} | Kirbot</title>
</svelte:head>

<main class="shell">
  <section class="card">
    <header class="hero">
      <p class="eyebrow">Kirbot Plan</p>
      <h1>{state.title}</h1>
      <p class="status">{state.status}</p>
    </header>

    {#if state.kind === "ready"}
      <pre class="plan-text">{state.artifact.text || "(empty plan)"}</pre>
    {:else if state.kind === "error"}
      <pre class="plan-text error-copy">{state.detail}</pre>
    {:else}
      <div class="plan-text skeleton" aria-hidden="true"></div>
    {/if}
  </section>
</main>
