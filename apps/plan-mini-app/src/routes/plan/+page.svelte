<script lang="ts">
  import { onMount } from "svelte";
  import { renderMarkdownToHtml } from "$lib/markdown-render";
  import {
    decodeMiniAppArtifact,
    getEncodedMiniAppArtifactFromHash,
    MiniAppArtifactType
  } from "@kirbot/core/mini-app/url";

  type ViewState =
    | { kind: "loading"; title: string; status: string }
    | { kind: "ready"; title: string; status: string; artifactHtml: string }
    | { kind: "error"; title: string; status: string; detail: string };

  let state: ViewState = {
    kind: "loading",
    title: "Plan",
    status: "Loading plan…"
  };
  let surfaceLabel = "Browser preview";
  let locationLabel = "hash://artifact";
  let titleSlug = "plan";

  onMount(() => {
    const telegram = window.Telegram?.WebApp ?? null;
    surfaceLabel = telegram ? "Telegram WebApp" : "Standalone view";
    telegram?.ready();
    telegram?.expand();

    const encodedArtifact = getEncodedMiniAppArtifactFromHash(window.location.hash);
    if (!encodedArtifact) {
      state = {
        kind: "error",
        title: "Plan",
        status: "This plan link is missing artifact details.",
        detail: "Missing encoded artifact payload."
      };
      return;
    }

    titleSlug = "plan";

    try {
      const artifact = decodeMiniAppArtifact(encodedArtifact);
      if (artifact.type !== MiniAppArtifactType.Plan) {
        throw new Error(`Unsupported artifact type: ${artifact.type}`);
      }

      titleSlug = (artifact.title || "Plan")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "plan";

      state = {
        kind: "ready",
        title: artifact.title || "Plan",
        status: "Completed plan artifact",
        artifactHtml: renderMarkdownToHtml(artifact.markdownText)
      };
    } catch (error: unknown) {
      state = {
        kind: "error",
        title: "Plan",
        status: "Failed to load this plan.",
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  });
</script>

<svelte:head>
  <title>{state.title} | Kirbot</title>
</svelte:head>

<main class="shell">
  <section class="workspace">
    <div class="workspace-topbar" aria-hidden="true">
      <div class="window-controls">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <p class="workspace-path">kirbot://mini-app/plan/{titleSlug}</p>
      <p class="workspace-surface">{surfaceLabel}</p>
    </div>

    <div class="workspace-body">
      <header class="hero">
        <div class="hero-copy">
          <p class="eyebrow">Kirbot Plan Artifact</p>
          <h1>{state.title}</h1>
          <p class="status">{state.status}</p>
        </div>

        <div class="hero-meta">
          <div class="meta-panel">
            <span class="meta-label">Source</span>
            <strong>{locationLabel}</strong>
          </div>
          <div class="meta-panel">
            <span class="meta-label">Surface</span>
            <strong>{surfaceLabel}</strong>
          </div>
          <div class="meta-panel">
            <span class="meta-label">State</span>
            <strong>{state.kind}</strong>
          </div>
        </div>
      </header>

      {#if state.kind === "ready"}
        <article class="plan-text plan-document">
          {@html state.artifactHtml}
        </article>
      {:else if state.kind === "error"}
        <pre class="plan-text error-copy">{state.detail}</pre>
      {:else}
        <div class="plan-text skeleton" aria-hidden="true"></div>
      {/if}
    </div>
  </section>
</main>
