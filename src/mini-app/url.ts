export function normalizeTelegramMiniAppPublicUrl(publicUrl: string | undefined): string | null {
  if (!publicUrl) {
    return null;
  }

  const parsed = new URL(publicUrl);
  return parsed.protocol === "https:" ? parsed.toString() : null;
}

export function deriveMiniAppBasePath(publicUrl: string): string {
  const pathname = new URL(publicUrl).pathname.replace(/\/+$/, "");
  return pathname || "";
}

export function deriveUrlOrigin(publicUrl: string): string {
  return new URL(publicUrl).origin;
}

export function buildPlanArtifactMiniAppUrl(publicUrl: string, turnId: string, itemId: string): string {
  const normalizedBaseUrl = publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`;
  const url = new URL("plan", normalizedBaseUrl);
  url.searchParams.set("turnId", turnId);
  url.searchParams.set("itemId", itemId);
  return url.toString();
}
