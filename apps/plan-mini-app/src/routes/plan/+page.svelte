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
    title: "Artifact",
    status: "Loading artifact…"
  };
  let artifactLabel = "Artifact";

  onMount(() => {
    const telegram = window.Telegram?.WebApp ?? null;
    telegram?.ready();
    telegram?.expand();

    const encodedArtifact = getEncodedMiniAppArtifactFromHash(window.location.hash);
    if (!encodedArtifact) {
      state = {
        kind: "error",
        title: "Artifact",
        status: "This artifact link is missing artifact details.",
        detail: "Missing encoded artifact payload."
      };
      return;
    }

    try {
      const artifact = decodeMiniAppArtifact(encodedArtifact);

      artifactLabel = artifact.type === MiniAppArtifactType.Commentary ? "Commentary" : "Plan";
      state = {
        kind: "ready",
        title: artifact.title || artifactLabel,
        status: `Completed ${artifactLabel.toLowerCase()} artifact`,
        artifactHtml: renderMarkdownToHtml(artifact.markdownText)
      };
    } catch (error: unknown) {
      state = {
        kind: "error",
        title: "Artifact",
        status: "Failed to load this artifact.",
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
    <div class="workspace-body">
      <header class="hero">
        <div class="hero-copy">
          <p class="eyebrow hero-label">KIRBOT • {artifactLabel.toUpperCase()}</p>
        </div>
        {#if state.kind !== "ready" && state.status}
          <p class="status">{state.status}</p>
        {/if}
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
