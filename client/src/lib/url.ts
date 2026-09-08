/**
 * Resolve a server-owned URL against that server, never the WebView. Local
 * servers return root-relative paths; configured media origins and signed
 * upload URLs are already absolute and must retain their exact bytes.
 */
export function absoluteUrl(baseUrl: string, url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${baseUrl}${url}`;
}
