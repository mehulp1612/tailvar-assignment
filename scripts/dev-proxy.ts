export const apiOrigin = "http://127.0.0.1:8787";

// Vite's HTTP dev server and Wrangler have different ports. Translate only an
// origin matching the browser-facing host; retain foreign origins for rejection.
export function forwardedOrigin(
  origin: string | undefined,
  host: string | undefined,
) {
  return host && origin === `http://${host}` ? apiOrigin : origin;
}
