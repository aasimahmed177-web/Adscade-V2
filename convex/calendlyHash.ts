/**
 * SHA-256 hex digest, using Web Crypto (available in the default Convex action runtime —
 * no "use node" needed). Matches Google Ads' enhanced-conversion hashing requirement:
 * hash the normalised value, never the raw one.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
