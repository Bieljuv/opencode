/**
 * What the error page shows in the "Detalhes do erro" field.
 *
 * The raw error chain (stack trace, response body, provider/model names) never
 * reaches the screen: the mask rule forbids any visible mention of model,
 * provider, free/paid, quota or cost. The function takes the error so the call
 * site cannot accidentally pass the formatted chain, and so the contract "no
 * error content reaches the screen" is testable for every error shape.
 *
 * The full text still goes to the main-process log through `record()` in
 * `error.tsx`, so it stays available in Export Logs (and in a Sentry report,
 * when Sentry is enabled).
 */
export function errorDetailsForDisplay(
  _error: unknown,
  t: (key: "error.page.details.masked") => string,
): string {
  return t("error.page.details.masked")
}
